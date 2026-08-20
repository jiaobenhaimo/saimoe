import { getActiveCompetition, startGroups, startKnockout, advanceKnockout, advanceGroupMatchday, resolvePlayoff, postponeNomination, qualifyingCount, canStartKnockout } from "./engine";
import { sweepOrphanNominations, freezeOf, breakOf, beginBreak, consumeBreak, setBreakAnchor, roundKeyOf } from "./db";
import { archiveRound } from "./backup";

/** Grace period before an un-voted self-nomination is swept (minutes). Env-tunable. */
const ORPHAN_GRACE_MIN = Number(process.env.SAIMOE_ORPHAN_GRACE_MIN) || 30;

let last = 0;

/**
 * Advance the competition if a deadline has passed. Safe to call often:
 * throttled per process, and every transition re-checks the phase so a
 * double-fire is a no-op. Runs periodically (instrumentation) and lazily on
 * each /api/state read.
 *
 * ── 休赛期（break）在这里插进流程 ────────────────────────────────────────────
 *
 * 一轮到点时，如果配了 break_hours，先进入休赛期而**不是**立刻结算：
 *
 *     投票中 ──到点──▶ 休赛期（停投，本轮票数已固定但尚未结算）──到点──▶ 结算并开下一轮
 *
 * 顺序是刻意这样定的。运营要的是「留几个小时看看票有没有问题」，那就必须在**结算之前**看：
 * 休赛期内票已经不再变动（停投），可以慢慢查、该作废的作废；等休赛期结束再结算，用的就是
 * 已经清理干净的数据。反过来先结算再查，则每次作废都得再点一次「按当前票数重算本轮」，
 * 而且淘汰赛里晋级者已经产生、下一轮对阵已经生成，改起来要连带撤回，很容易出错。
 *
 * 与「维护冻结」(freeze) 的区别：freeze 是运营手动按下的暂停，期间调度器整体停摆（正是为了
 * 让人在静止的数据上改东西）；break 是赛程的正常组成部分，由调度器自己进出，因此下面的
 * freeze 提前返回**必须**放在 break 处理之前 —— 否则休赛期一旦开始就没人来结束它。
 */
export function runTick(force = false): void {
  const now = Date.now();
  if (!force && now - last < 20_000) return;
  last = now;
  try {
    const comp = getActiveCompetition();
    if (!comp) return;

    // 维护冻结期间不做任何自动推进：停投的目的就是让 admin 能在静止的数据上修改，
    // 若定时器照旧把比赛日推进/开淘汰赛，就等于一边修一边被改。
    if (freezeOf(comp).active) return;

    const brk = breakOf(comp, now);
    // 休赛期中：什么都不做，等它自然到点（停投由 /api/vote、/api/nominate 各自拦下）。
    //
    // BUG FIX：孤儿提名清理原本在这一行**之前**，于是休赛期里照样在删角色。那正好破坏休赛期的
    // 前提——池子静止、运营可以放心核对：名单会在他们眼下变化，而休赛期结束后取前 N 名算的
    // 又是变化之后的池子。而且此时提名已被拦下，被清理者连"补一票救回来"的机会都没有。
    if (brk.active) return;
    // 休赛期已过但 break_until 还留着 → 清掉，避免陈旧值留在数据里（break_after 保留，
    // 它记着"这一轮已经处理过"，是防止重复插入休赛期的依据）。
    if (comp.break_until != null) consumeBreak(comp.id);

    // garbage-collect abandoned 0-vote self-nominations while nomination is open
    if (comp.phase === "nomination") sweepOrphanNominations(comp.id, ORPHAN_GRACE_MIN * 60_000);

    const round = roundKeyOf(comp);
    /**
     * 到点了：该先进休赛期，还是直接推进？
     * 返回 true 表示「已开启休赛期，本次不推进」。
     * break_after 记的是「休赛期跟在哪一轮之后」，用它防止同一轮反复插入休赛期 ——
     * 否则休赛期结束、推进失败（例如淘汰赛凑不齐）时会原地循环，永远进不了下一轮。
     */
    const holdForBreak = (dueAt: number | null): boolean => {
      if (brk.hours <= 0) { archiveRound(round); return false; } // 未启用休赛期：仍然归档这一轮
      if (comp.break_after === round) {          // 这一轮的休赛期已经用掉了
        consumeBreak(comp.id);                   // 清掉残留的 until（正常情况已是 null）
        return false;
      }
      // dueAt = 触发这次休赛期的**原定截止时刻**（不是 now）。下一轮的截止以它为基准，
      // 休赛期因此从本轮投票时间里扣掉，而不会让每一轮都比上一轮晚 N 小时（见 break_anchor）。
      // 一轮投票到此为止 → 先留一份永久归档（不参与快照轮转），再进休赛期。
      // 时机选在这里而不是结算之后：归档的正是"运营即将开始核对"的那份原始数据，
      // 事后有争议时对得上；结算后再存就已经混入了作废/重算的结果。
      archiveRound(round);
      const until = beginBreak(comp.id, brk.hours, round, dueAt);
      console.log(`saimoe: entering ${brk.hours}h break after ${round} (due ${dueAt ? new Date(dueAt).toISOString() : "?"}), resumes at ${until ? new Date(until).toISOString() : "?"}`);
      return true;
    };

    if (comp.phase === "nomination" && comp.nom_ends_at && now >= comp.nom_ends_at) {
      const size = comp.auto_size || 0;
      // #4: count only candidates clearing nom_min_votes (what startGroups actually ranks),
      //     else a high threshold makes the guard pass but startGroups throw → retry forever.
      // 先检查人数、再决定是否进休赛期：池子不够时应当顺延提名，而不是先停投几小时再顺延
      // （那几小时里没人能补提名，等于白等）。
      if (!(size > 0 && qualifyingCount(comp.id) >= size)) {
        postponeNomination(comp.id); // pool too small → push the deadline back and try again later
        return;
      }
      // 提名截止的处理顺序与其他轮次**相反**：先抽签，再进休赛期。
      //
      // 其他轮次休赛期在结算之前（票还能改，作废后重算才有意义）。但提名之后运营要看的不只是
      // 票，还有「按这个票数分出来的组长什么样」—— 那就必须先真的分一次。所以这里先跑
      // startGroups（取前 N、分组、定种子），再进休赛期；休赛期内投票依然关闭（/api/vote 按
      // break_until 拦，与阶段无关），运营可以查票、可以按新票数点「重新分组」重抽，
      // 直到满意为止。休赛期一结束，小组赛第 1 比赛日就按既有分组开投。
      const already = breakOf(comp, now);
      if (already.after !== round) {
        // 归档要在抽签**之前**：留下的是运营即将核对的原始提名数据
        archiveRound(round);
        // 锚点必须比抽签更早写入：startGroups 算第 1 比赛日的截止时间时要以**原定提名截止**
        // 为基准，否则休赛期那几小时会被算进赛程，整条时间线往后顺延（见 deadlineBase）。
        setBreakAnchor(comp.id, comp.nom_ends_at ?? null);
        try {
          startGroups(comp.id, size);
        } catch (e) {
          console.error("saimoe: auto startGroups failed, postponing", e);
          setBreakAnchor(comp.id, null); // 抽签没成功，锚点不能留着套用到别的轮次
          postponeNomination(comp.id);
          return;
        }
        if (brk.hours > 0) {
          // 锚点已经被 startGroups 用掉了（第 1 比赛日的截止就是按它算的），这里传 null ——
          // 再放一次会让它留到下一轮，把 matchday 1→2 的截止错误地锚到提名截止上。
          const until = beginBreak(comp.id, brk.hours, round, null);
          console.log(`saimoe: drew groups, entering ${brk.hours}h break after ${round}, resumes at ${until ? new Date(until).toISOString() : "?"}`);
        } else {
          // 没配休赛期：抽完直接开投（旧行为）。仍要标记这一轮已处理，避免重复进入。
          beginBreak(comp.id, 0, round, null);
        }
        return;
      }
      // break_after === round：这一轮已经抽过签并走完休赛期了，不该再来一次
      return;
    } else if (comp.phase === "group" && comp.group_round_ends_at && now >= comp.group_round_ends_at) {
      // per-matchday advance; when the last matchday settles, roll into knockout.
      // #5: if this is the final matchday but the bracket can't be built, don't advance-then-fail.
      const isLast = (comp.group_matchday ?? 1) >= (comp.group_matchday_count ?? 1);
      if (isLast && !canStartKnockout(comp.id)) {
        console.error("saimoe: final matchday due but knockout unfillable — leaving group phase intact");
        return;
      }
      if (holdForBreak(comp.group_round_ends_at)) return;
      const r = advanceGroupMatchday(comp.id);
      if (r.done) startKnockout(comp.id);
    } else if (comp.phase === "group" && comp.group_ends_at && now >= comp.group_ends_at) {
      if (holdForBreak(comp.group_ends_at)) return;
      startKnockout(comp.id); // legacy (comps started before matchday scheduling)
    } else if (comp.phase === "playoff" && comp.group_round_ends_at && now >= comp.group_round_ends_at) {
      if (holdForBreak(comp.group_round_ends_at)) return;
      resolvePlayoff(comp.id);
    } else if (comp.phase === "knockout" && comp.ko_round_ends_at && now >= comp.ko_round_ends_at) {
      if (holdForBreak(comp.ko_round_ends_at)) return;
      advanceKnockout(comp.id);
    }
  } catch (e) {
    console.error("saimoe: scheduler tick error", e);
  }
}
