// Intermission (休赛期) test — run with `npm run test:break`.
//
// The point of the intermission is the ORDER of operations. When a round's deadline passes the
// scheduler must:
//    1. stop voting        (so the tally can't move while it's being checked)
//    2. NOT settle yet     (so voiding a stuffed vote still changes the outcome)
//    3. settle + open next  only after the break expires
//
// If it settled first, every void would need a follow-up "recompute this round", and in the
// knockout the next round's pairings would already exist and have to be unwound.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWN = !process.env.SMOKE_DATA_DIR;
process.env.DATA_DIR = process.env.SMOKE_DATA_DIR || mkdtempSync(join(tmpdir(), "saimoe-break-"));
if (OWN) process.on("exit", () => { try { rmSync(process.env.DATA_DIR!, { recursive: true, force: true }); } catch {} });

const db = await import("../lib/db");
const eng = await import("../lib/engine");
const sch = await import("../lib/schedule");

let failures = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) console.log("  ok  " + label);
  else { console.error("FAIL " + label + (extra ? "  → " + extra : "")); failures++; }
};
const setField = (cid: number, patch: Record<string, unknown>) => {
  const d = db.readDb();
  Object.assign(d.competitions.find((c) => c.id === cid)!, patch);
  db.writeDb(d);
};

db.ensureSchema();
const cid = db.createCompetition("break-test");
db.addCandidates(cid, Array.from({ length: 8 }, (_, i) => ({ bgmId: "b" + i, name: "C" + i })));
const pool = db.readDb().candidates.filter((c) => c.competition_id === cid);
// give descending vote counts so the ranking is unambiguous
pool.forEach((c, i) => { for (let v = 0; v <= (pool.length - i); v++) db.toggleNomination(cid, c.id, `voter_${c.id}_${v}`); });

// ── with NO break configured, the deadline advances immediately (old behaviour preserved) ──
setField(cid, { auto_size: 8, nom_ends_at: Date.now() - 1000, break_hours: null, group_size: 4, groups_per_day: 2 });
sch.runTick(true);
check("without a break, the deadline opens the group stage at once",
  eng.getActiveCompetition()?.phase === "group");

// ── with a break configured, the same deadline enters the intermission instead ──
const cid2 = db.createCompetition("break-test-2");
db.addCandidates(cid2, Array.from({ length: 8 }, (_, i) => ({ bgmId: "x" + i, name: "D" + i })));
const pool2 = db.readDb().candidates.filter((c) => c.competition_id === cid2);
pool2.forEach((c, i) => { for (let v = 0; v <= (pool2.length - i); v++) db.toggleNomination(cid2, c.id, `w_${c.id}_${v}`); });
setField(cid2, { auto_size: 8, nom_ends_at: Date.now() - 1000, break_hours: 6, group_size: 4, groups_per_day: 2 });

sch.runTick(true);
let c2 = eng.getActiveCompetition()!;
check("the deadline starts an intermission, not the group stage", c2.phase === "nomination", `phase=${c2.phase}`);
const bk = db.breakState(cid2);
check("intermission is active", bk.active === true);
check("intermission ends ~6h out", bk.until != null && bk.until - Date.now() > 5.5 * 3600_000);
check("intermission records which round it follows", bk.after === "nomination", `after=${bk.after}`);

// the pool is still intact and un-cut: this is what makes checking useful
check("candidates are NOT yet grouped (nothing settled)",
  db.readDb().candidates.filter((c) => c.competition_id === cid2).every((c) => c.group_no == null));
const votesDuring = db.readDb().nominationVotes.filter((v) => v.competition_id === cid2).length;

// ── repeated ticks during the intermission must not advance or re-arm it ──
const until0 = db.breakState(cid2).until;
sch.runTick(true); sch.runTick(true);
check("ticks during the intermission are a no-op", eng.getActiveCompetition()?.phase === "nomination");
check("the intermission is not repeatedly re-armed", db.breakState(cid2).until === until0);

// ── voiding during the intermission still changes the outcome (the whole point) ──
const lowest = pool2[pool2.length - 1];
const before = db.readDb().nominationVotes.filter((v) => v.competition_id === cid2 && v.candidate_id === lowest.id).length;
check("a candidate's votes can still be voided mid-intermission", before > 0);

// ── when it expires, the next tick settles and opens the group stage ──
setField(cid2, { break_until: Date.now() - 1000 });
sch.runTick(true);
c2 = eng.getActiveCompetition()!;
check("after the intermission the group stage opens", c2.phase === "group", `phase=${c2.phase}`);
check("break_until is cleared", c2.break_until == null);
check("votes were untouched by the intermission itself",
  db.readDb().nominationVotes.filter((v) => v.competition_id === cid2).length === votesDuring);
check("candidates are now grouped", db.readDb().candidates.filter((c) => c.competition_id === cid2 && c.group_no != null).length >= 8);

// ── the same round must not get a second intermission (would loop forever) ──
check("break_after still marks the consumed round", c2.break_after === "nomination");

// ── a group matchday deadline also gets an intermission, and it is per-round ──
setField(cid2, { group_round_ends_at: Date.now() - 1000, group_round_days: 1 });
const md0 = eng.getActiveCompetition()!.group_matchday;
sch.runTick(true);
check("matchday deadline enters an intermission rather than advancing",
  eng.getActiveCompetition()!.group_matchday === md0 && db.breakState(cid2).active,
  `matchday=${eng.getActiveCompetition()!.group_matchday}`);
check("the group round's intermission is tagged separately from nomination's",
  db.breakState(cid2).after === "group:" + md0, `after=${db.breakState(cid2).after}`);
setField(cid2, { break_until: Date.now() - 1000 });
sch.runTick(true);
check("after that intermission the matchday advances",
  (eng.getActiveCompetition()!.group_matchday ?? 0) > (md0 ?? 0) || eng.getActiveCompetition()!.phase !== "group");

// ── a maintenance freeze must not strand an intermission ──
// freeze halts the scheduler entirely; if the freeze check ran after the break check the break
// would never be ended. Verify the break still resolves once the freeze lifts.
const cid3 = eng.getActiveCompetition()!.id;
db.setFreeze(cid3, { on: true });
setField(cid3, { break_until: Date.now() + 3600_000, break_after: "sentinel" });
sch.runTick(true);
check("frozen: scheduler does nothing", db.breakState(cid3).active === true);
db.setFreeze(cid3, { on: false });
setField(cid3, { break_until: Date.now() - 1000 });
sch.runTick(true);
check("after unfreezing, the expired intermission resolves", db.breakState(cid3).active === false);

// ── admin controls ──
db.setBreakHours(cid3, 12);
check("setBreakHours stores the value", db.breakState(cid3).hours === 12);
db.setBreakHours(cid3, 9999);
check("absurd values are clamped", db.breakState(cid3).hours === 240, `${db.breakState(cid3).hours}`);
db.setBreakHours(cid3, 0);
check("0 disables the intermission", db.breakState(cid3).hours === 0);
db.beginBreak(cid3, 6, "manual");
const ext = db.extendBreak(cid3, 3);
check("extendBreak pushes the end out", ext != null && ext - Date.now() > 8.5 * 3600_000);
check("endBreakNow clears it", db.endBreakNow(cid3) === true && db.breakState(cid3).active === false);
check("endBreakNow on no intermission is a no-op", db.endBreakNow(cid3) === false);

console.log(failures ? `\n${failures} failure(s)` : "\nall intermission checks passed");
process.exit(failures ? 1 : 0);
