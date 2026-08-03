import { getActiveCompetition, startGroups, startKnockout, advanceKnockout, advanceGroupMatchday, resolvePlayoff, postponeNomination, poolSize } from "./engine";

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

    if (comp.phase === "nomination" && comp.nom_ends_at && now >= comp.nom_ends_at) {
      const size = comp.auto_size || 0;
      if (size > 0 && poolSize(comp.id) >= size) {
        startGroups(comp.id, size);
      } else {
        // pool too small → push the deadline back and try again later
        postponeNomination(comp.id);
      }
    } else if (comp.phase === "group" && comp.group_round_ends_at && now >= comp.group_round_ends_at) {
      // per-matchday advance; when the last matchday settles, roll into knockout
      const r = advanceGroupMatchday(comp.id);
      if (r.done) startKnockout(comp.id);
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
