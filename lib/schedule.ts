import { getActiveCompetition, startGroups, startKnockout, advanceKnockout, advanceGroupMatchday, resolvePlayoff, postponeNomination, qualifyingCount, canStartKnockout } from "./engine";
import { sweepOrphanNominations, freezeOf, breakOf, beginBreak, consumeBreak, roundKeyOf } from "./db";

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

    // garbage-collect abandoned 0-vote self-nominations while nomination is open
    if (comp.phase === "nomination") sweepOrphanNominations(comp.id, ORPHAN_GRACE_MIN * 60_000);

    const round = roundKeyOf(comp);
    /**
     * 到点了：该先进休赛期，还是直接推进？
     * 返回 true 表示「已开启休赛期，本次不推进」。
     * break_after 记的是「休赛期跟在哪一轮之后」，用它防止同一轮反复插入休赛期 ——
     * 否则休赛期结束、推进失败（例如淘汰赛凑不齐）时会原地循环，永远进不了下一轮。
     */
    const holdForBreak = (): boolean => {
      if (brk.hours <= 0) return false;          // 未启用休赛期
      if (comp.break_after === round) {          // 这一轮的休赛期已经用掉了
        consumeBreak(comp.id);                   // 清掉残留的 until（正常情况已是 null）
        return false;
      }
      const until = beginBreak(comp.id, brk.hours, round);
      console.log(`saimoe: entering ${brk.hours}h break after ${round}, resumes at ${until ? new Date(until).toISOString() : "?"}`);
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
      // 提名截止 → 休赛期（查提名票）→ 按清理后的票数取前 N 名开小组赛
      if (holdForBreak()) return;
      try {
        startGroups(comp.id, size);
      } catch (e) {
        // impossible/degenerate config shouldn't wedge the scheduler — push the deadline back
        console.error("saimoe: auto startGroups failed, postponing", e);
        postponeNomination(comp.id);
      }
    } else if (comp.phase === "group" && comp.group_round_ends_at && now >= comp.group_round_ends_at) {
      // per-matchday advance; when the last matchday settles, roll into knockout.
      // #5: if this is the final matchday but the bracket can't be built, don't advance-then-fail.
      const isLast = (comp.group_matchday ?? 1) >= (comp.group_matchday_count ?? 1);
      if (isLast && !canStartKnockout(comp.id)) {
        console.error("saimoe: final matchday due but knockout unfillable — leaving group phase intact");
        return;
      }
      if (holdForBreak()) return;
      const r = advanceGroupMatchday(comp.id);
      if (r.done) startKnockout(comp.id);
    } else if (comp.phase === "group" && comp.group_ends_at && now >= comp.group_ends_at) {
      if (holdForBreak()) return;
      startKnockout(comp.id); // legacy (comps started before matchday scheduling)
    } else if (comp.phase === "playoff" && comp.group_round_ends_at && now >= comp.group_round_ends_at) {
      if (holdForBreak()) return;
      resolvePlayoff(comp.id);
    } else if (comp.phase === "knockout" && comp.ko_round_ends_at && now >= comp.ko_round_ends_at) {
      if (holdForBreak()) return;
      advanceKnockout(comp.id);
    }
  } catch (e) {
    console.error("saimoe: scheduler tick error", e);
  }
}
