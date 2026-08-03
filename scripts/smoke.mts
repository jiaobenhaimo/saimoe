// Engine smoke test — run with `npm test` (tsx scripts/smoke.mts). Exercises the core
// competition flow and guards against regressions (day cap, matchday dates, undo,
// pick'em removal, knockout progression). Uses a throwaway DATA_DIR.
process.env.DATA_DIR = process.env.SMOKE_DATA_DIR || "/tmp/saimoe-smoke";

// Dynamic imports so DATA_DIR is set before lib/db reads it (ESM hoists static imports).
const db = await import("../lib/db");
const eng = await import("../lib/engine");
const { createCompetition, addCandidate, toggleNomination, ensureSchema } = db;
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
startGroups(cid, 16, 0, 1); // roundDays = 1 so matchday dates are computed
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

console.log(failures ? `\n${failures} failure(s)` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
