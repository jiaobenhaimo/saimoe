import { getActiveCompetition, startGroups, startKnockout, advanceKnockout, advanceGroupMatchday, resolvePlayoff, postponeNomination, qualifyingCount, canStartKnockout } from "./engine";
import { sweepOrphanNominations, freezeOf } from "./db";

/** Grace period before an un-voted self-nomination is swept (minutes). Env-tunable. */
const ORPHAN_GRACE_MIN = Number(process.env.SAIMOE_ORPHAN_GRACE_MIN) || 30;

let last = 0;

/**
 * Advance the competition if a deadline has passed. Safe to call often:
 * throttled per process, and every transition re-checks the phase so a
 * double-fire is a no-op. Runs periodically (instrumentation) and lazily on
 * each /api/state read.
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

    // garbage-collect abandoned 0-vote self-nominations while nomination is open
    if (comp.phase === "nomination") sweepOrphanNominations(comp.id, ORPHAN_GRACE_MIN * 60_000);

    if (comp.phase === "nomination" && comp.nom_ends_at && now >= comp.nom_ends_at) {
      const size = comp.auto_size || 0;
      // #4: count only candidates clearing nom_min_votes (what startGroups actually ranks),
      //     else a high threshold makes the guard pass but startGroups throw → retry forever.
      if (size > 0 && qualifyingCount(comp.id) >= size) {
        try {
          startGroups(comp.id, size);
        } catch (e) {
          // impossible/degenerate config shouldn't wedge the scheduler — push the deadline back
          console.error("saimoe: auto startGroups failed, postponing", e);
          postponeNomination(comp.id);
        }
      } else {
        // pool too small → push the deadline back and try again later
        postponeNomination(comp.id);
      }
    } else if (comp.phase === "group" && comp.group_round_ends_at && now >= comp.group_round_ends_at) {
      // per-matchday advance; when the last matchday settles, roll into knockout.
      // #5: if this is the final matchday but the bracket can't be built, don't advance-then-fail.
      const isLast = (comp.group_matchday ?? 1) >= (comp.group_matchday_count ?? 1);
      if (isLast && !canStartKnockout(comp.id)) {
        console.error("saimoe: final matchday due but knockout unfillable — leaving group phase intact");
      } else {
        const r = advanceGroupMatchday(comp.id);
        if (r.done) startKnockout(comp.id);
      }
    } else if (comp.phase === "group" && comp.group_ends_at && now >= comp.group_ends_at) {
      startKnockout(comp.id); // legacy (comps started before matchday scheduling)
    } else if (comp.phase === "playoff" && comp.group_round_ends_at && now >= comp.group_round_ends_at) {
      resolvePlayoff(comp.id);
    } else if (comp.phase === "knockout" && comp.ko_round_ends_at && now >= comp.ko_round_ends_at) {
      advanceKnockout(comp.id);
    }
  } catch (e) {
    console.error("saimoe: scheduler tick error", e);
  }
}
