// Engine smoke test — run with `npm test` (tsx scripts/smoke.mts). Exercises the core
// competition flow and guards against regressions (day cap, matchday dates, undo,
// pick'em removal, knockout progression). Uses a throwaway DATA_DIR.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Fresh dir per run (unless SMOKE_DATA_DIR is pinned by CI) so a pass never depends on
// leftover state from a previous local run; cleaned up on exit.
const OWN_DIR = !process.env.SMOKE_DATA_DIR;
process.env.DATA_DIR = process.env.SMOKE_DATA_DIR || mkdtempSync(join(tmpdir(), "saimoe-smoke-"));
if (OWN_DIR) process.on("exit", () => { try { rmSync(process.env.DATA_DIR!, { recursive: true, force: true }); } catch {} });

// Dynamic imports so DATA_DIR is set before lib/db reads it (ESM hoists static imports).
const db = await import("../lib/db");
const eng = await import("../lib/engine");
const { createCompetition, addCandidate, toggleNomination, ensureSchema, castApprovalVote } = db;
const { getState, startGroups, advanceGroupMatchday, startKnockout, advanceKnockout, undoLastTransition, setGroupDayCap, getActiveCompetition } = eng;

let failures = 0;
const check = (label: string, cond: boolean) => {
  if (cond) console.log("  ok  " + label);
  else { console.error("FAIL " + label); failures++; }
};

ensureSchema();
const cid = createCompetition("Smoke");
for (let i = 1; i <= 16; i++) addCandidate(cid, "bgm" + i, "Char" + i, "", "");
for (let i = 1; i <= 16; i++) toggleNomination(cid, i, "v" + i);

// ── group stage: day cap + dated matchups ──
setGroupDayCap(cid, 3);
startGroups(cid, 16, 0, 1, 0, "rr"); // roundDays = 1 so matchday dates are computed; rr mode = 1v1 round-robin
let s: any = getState("x");
check("group phase reached", s.competition.phase === "group");
const perDay = new Map<number, number>();
for (const g of s.group.groups) for (const m of g.matchups) perDay.set(m.matchday, (perDay.get(m.matchday) || 0) + 1);
check("day cap 3 enforced", Math.max(...perDay.values()) <= 3);
check("matchups carry matchday + date", s.group.groups.every((g: any) => g.matchups.every((m: any) => typeof m.matchday === "number" && typeof m.date === "number")));
check("no pick'em key in state", !("pick" in s));

const md1 = s.group.groups[0].matchups.find((m: any) => m.matchday === 1)?.date as number;
check("matchday 1 has a date", typeof md1 === "number");

// ── advancing must NOT shift past matchday dates (regression) ──
advanceGroupMatchday(cid);
advanceGroupMatchday(cid);
s = getState("x");
let md1After: number | null = null;
for (const g of s.group.groups) for (const m of g.matchups) if (m.matchday === 1) md1After = m.date;
check("matchday 1 date stable after advancing", md1After === md1);

// ── finish the tournament → knockout nextLabel → finished → dates persist ──
let cur = s.group.matchday, cnt = s.group.matchdayCount;
while (cur < cnt) { const r = advanceGroupMatchday(cid); cur = r.done ? cnt : (getActiveCompetition() as any).group_matchday; }
startKnockout(cid);
s = getState("x");
check("knockout reached with nextLabel", s.competition.phase === "knockout" && typeof s.knockout.nextLabel === "string");
let guard = 0;
while ((getActiveCompetition() as any)?.phase === "knockout" && guard++ < 20) advanceKnockout(cid);
s = getState("x");
check("finished reached with champion", s.competition.phase === "finished" && !!s.knockout.champion);
let md1Final: number | null = null;
for (const g of s.group.groups) for (const m of g.matchups) if (m.matchday === 1) md1Final = m.date;
check("group dates persist after finish", md1Final === md1);

// ── undo chain: finished → knockout → ... → group → nomination ──
check("undo leaves finished", getActiveCompetition()?.phase === "finished");
let guard2 = 0;
while (getActiveCompetition()?.phase !== "nomination" && guard2++ < 12) undoLastTransition(cid);
check("undo chain back to nomination", getActiveCompetition()?.phase === "nomination");

// ── approval mode (default): group ballots, ≤2 picks, top-2 advance, knockout handoff ──
const cid2 = createCompetition("approval-smoke");
for (let i = 1; i <= 8; i++) addCandidate(cid2, "a" + i, "AC" + i, "", "");
const pool2 = (getState("seed") as any).nomination.pool as any[];
pool2.forEach((c: any, i: number) => { for (let v = 0; v <= i; v++) toggleNomination(cid2, c.id, `n${c.id}_${v}`); });
startGroups(cid2, 8, 0, 0, 4, "approval", 2); // 8→2 groups of 4, 2 groups/day → 1 batch
let sa = getState("viewer");
check("approval mode set", sa.group.mode === "approval" && sa.group.groups.length === 2);
const gm = sa.group.groups[0].members;
check("approval group open with members", sa.group.groups[0].open === true && gm.length === 4);
const p1 = castApprovalVote(cid2, gm[0].id, "viewer", {});
const p2 = castApprovalVote(cid2, gm[1].id, "viewer", {});
const p3 = castApprovalVote(cid2, gm[2].id, "viewer", {});
check("approval ≤2 picks enforced", (p1 as any).picked && (p2 as any).picked && "error" in (p3 as any));
sa = getState("viewer");
check("approval hides live counts", sa.group.groups[0].members[0].votes === null);
let ga = 0; while ((getActiveCompetition() as any)?.group_matchday && (getActiveCompetition() as any)?.phase === "group" && ga++ < 6) { const r = advanceGroupMatchday(cid2); if (r.done) break; }
startKnockout(cid2);
check("approval → knockout handoff", getActiveCompetition()?.phase === "knockout");

// ── bracket construction refuses to write a corrupt matchup ──
// A knockout matchup with a missing side can never be resolved by voting: decide() reads a
// candidate that isn't there and the round wedges. resolvePlayoff could produce exactly that
// whenever the bracket had more holes than the playoff had survivors, so both layers now refuse.
{
  const cidP = createCompetition("bracket-guard");
  for (let i = 1; i <= 4; i++) addCandidate(cidP, "pg" + i, "PG" + i, "", "");
  const ids = db.readDb().candidates.filter((c: any) => c.competition_id === cidP).map((c: any) => c.id);
  const d = db.readDb();
  const cp = d.competitions.find((x: any) => x.id === cidP)!;
  cp.phase = "playoff";
  cp.playoff_slots = 3;                                  // three holes to fill…
  cp.ko_seed_ids = [ids[0], null, null, null] as any;
  d.matchups.push({ id: ++d.seq.matchup, competition_id: cidP, stage: "playoff", round_no: 1,
    group_no: null, slot: 0, a_id: ids[1], b_id: ids[2], winner_id: null, decided: false });
  db.writeDb(d);

  let threw = "";
  try { eng.resolvePlayoff(cidP); } catch (e: any) { threw = e?.message || "?"; }
  check("resolvePlayoff refuses to fill more holes than it has survivors", /名额待填/.test(threw), threw);
  const ko = db.readDb().matchups.filter((m: any) => m.competition_id === cidP && m.stage === "knockout");
  check("no knockout matchup was written", ko.length === 0, `wrote ${ko.length}`);
  check("the playoff phase is left intact and retryable",
    (db.readDb().competitions.find((x: any) => x.id === cidP) as any).phase === "playoff");
}

console.log(failures ? `\n${failures} failure(s)` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
