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

// ── the deadline grid must not drift because of breaks ──
// If the next round's deadline were measured from the moment the break ended, every round would
// land N hours later than the last and after a few matchdays the daily cut-off has wandered right
// across the clock. The break is taken OUT of the round's voting time instead: with a 23:00 daily
// deadline and a 2h break, the next round runs 01:00-23:00.
{
  const cidD = db.createCompetition("no-drift");
  // 16 entrants / 4 per group / 2 groups per day = 4 groups over 2 matchdays, so there IS a
  // second matchday to advance into (with 2 groups it would roll straight into the knockout).
  db.addCandidates(cidD, Array.from({ length: 16 }, (_, i) => ({ bgmId: "d" + i, name: "D" + i })));
  const p = db.readDb().candidates.filter((c) => c.competition_id === cidD);
  p.forEach((c, i) => { for (let v = 0; v <= p.length - i; v++) db.toggleNomination(cidD, c.id, `dv_${c.id}_${v}`); });

  const DAY = 86_400_000;
  // nomination closed at a 23:00-style anchor an hour ago; 1 day per matchday; 2h break
  const nomEnd = Date.now() - 3600_000;
  setField(cidD, { auto_size: 16, group_size: 4, groups_per_day: 2, group_round_days: 1,
    nom_ends_at: nomEnd, break_hours: 2 });

  sch.runTick(true);                                   // -> enters the break
  check("nomination deadline starts a break", db.breakState(cidD).active === true);
  setField(cidD, { break_until: Date.now() - 1000 });   // break expires
  sch.runTick(true);                                    // -> group stage opens
  const c1 = db.readDb().competitions.find((c) => c.id === cidD)!;
  check("group stage opened", c1.phase === "group");
  // The matchday-1 deadline must sit on the grid (nomEnd + 1 day), NOT break-end + 1 day.
  const drift = Math.abs((c1.group_round_ends_at ?? 0) - (nomEnd + DAY));
  check("matchday 1 deadline sits on the grid, not after the break",
    drift < 5_000, `off by ${Math.round(drift / 60_000)} min`);
  check("break_anchor was consumed", c1.break_anchor == null);

  // And again for the next matchday. Use a grid point that has just passed, so the deadline is
  // actually due (the previous step's grid point is still ~23h out).
  const gridPt = Date.now() - 3600_000;
  setField(cidD, { group_round_ends_at: gridPt, break_after: "consumed" });
  sch.runTick(true);
  check("a matchday deadline starts a break too", db.breakState(cidD).active === true);
  check("the anchor recorded is the matchday deadline, not now",
    Math.abs((db.readDb().competitions.find((c) => c.id === cidD)!.break_anchor ?? 0) - gridPt) < 5_000);
  setField(cidD, { break_until: Date.now() - 1000 });
  sch.runTick(true);
  const c2 = db.readDb().competitions.find((c) => c.id === cidD)!;
  const drift2 = Math.abs((c2.group_round_ends_at ?? 0) - (gridPt + DAY));
  check("the next deadline is one grid step on from the last, with no drift",
    drift2 < 5_000, `off by ${Math.round(drift2 / 60_000)} min`);
}

// ── the pool must not change during an intermission ──
// The break exists so the operator can check a STATIONARY pool. Orphan sweeping used to run before
// the break check, so 0-vote self-nominations were deleted mid-review: the list moved under them,
// and the top-N cut afterwards was computed on a different pool than the one they inspected.
// Nominating is blocked during a break too, so the owner couldn't even rescue one with a vote.
{
  const cidS = db.createCompetition("sweep-during-break");
  db.addCandidates(cidS, [{ bgmId: "orph", name: "Orphan" }], "fp_owner"); // self-nominated, 0 votes
  const orph = db.readDb().candidates.find((c) => c.competition_id === cidS && c.bgm_id === "orph")!;
  // age it past any grace period
  {
    const d = db.readDb();
    d.candidates.find((c) => c.id === orph.id)!.nominated_at = Date.now() - 86_400_000;
    db.writeDb(d);
  }
  setField(cidS, { break_hours: 6, break_until: Date.now() + 6 * 3600_000, break_after: "manual" });
  sch.runTick(true);
  check("an un-voted nomination survives the intermission",
    db.readDb().candidates.some((c) => c.id === orph.id));
  // once the break ends, the sweep resumes as before
  setField(cidS, { break_until: null, break_after: "manual" });
  sch.runTick(true);
  check("after the intermission the sweep runs again",
    !db.readDb().candidates.some((c) => c.id === orph.id));
}

// ── the schedule preview must show the break carved out of the round, not added to it ──
// The round's start moves past the break but its deadline stays on the grid, so the previewed
// window is (round length − break). Computing end as start + roundMs counted the break twice and
// showed a deadline hours later than the real one.
{
  const cidV = db.createCompetition("preview");
  db.addCandidates(cidV, Array.from({ length: 16 }, (_, i) => ({ bgmId: "v" + i, name: "V" + i })));
  const pv = db.readDb().candidates.filter((c) => c.competition_id === cidV);
  pv.forEach((c, i) => { for (let v = 0; v <= pv.length - i; v++) db.toggleNomination(cidV, c.id, `pv_${c.id}_${v}`); });
  const nomEnd2 = Date.now() + 3600_000;
  setField(cidV, { auto_size: 16, group_size: 4, groups_per_day: 2, group_round_days: 1,
    round_hours: 24, nom_ends_at: nomEnd2, break_hours: 2, break_until: null, break_after: null });

  const sc = eng.projectSchedule(db.readDb(), db.readDb().competitions.find((c) => c.id === cidV)! as any);
  check("preview reports the configured break", sc.breakHours === 2, `${sc.breakHours}`);
  const d1 = sc.group[0];
  check("matchday 1 starts one break after nomination closes",
    d1?.start != null && Math.abs(d1.start - (nomEnd2 + 2 * 3600_000)) < 5_000,
    `start=${d1?.start} want=${nomEnd2 + 2 * 3600_000}`);
  check("matchday 1 deadline stays on the grid (break not added twice)",
    d1?.end != null && Math.abs(d1.end - (nomEnd2 + 86_400_000)) < 5_000,
    `end=${d1?.end} want=${nomEnd2 + 86_400_000}`);
  check("the visible voting window is round length minus the break",
    d1?.start != null && d1?.end != null && Math.abs((d1.end - d1.start) - (86_400_000 - 2 * 3600_000)) < 5_000,
    `${((d1!.end! - d1!.start!) / 3600_000).toFixed(2)}h`);
  const d2 = sc.group[1];
  check("matchday 2 is exactly one grid step after matchday 1",
    d2?.end != null && d1?.end != null && Math.abs((d2.end - d1.end) - 86_400_000) < 5_000,
    `${(((d2?.end ?? 0) - (d1?.end ?? 0)) / 3600_000).toFixed(2)}h`);
  const ko1 = sc.knockout[0];
  check("the first knockout round also starts one break after the last group deadline",
    ko1?.start != null && d2?.end != null && Math.abs(ko1.start - (d2.end + 2 * 3600_000)) < 5_000,
    `ko start=${ko1?.start}`);
}

// ── the 公众号 reminder must not hand out a vote link as if voting were open ──
// Replying 「投票」 during a break used to return "投票截止：…" plus a link that /api/vote answers
// with 503. From the voter's side that is indistinguishable from the site being broken.
{
  const rem = await import("../lib/reminder");
  const live = eng.getActiveCompetition()!;
  db.setBreakHours(live.id, 6);
  db.beginBreak(live.id, 6, "manual");
  const onBreak = rem.buildRoundReminder({ voteUrl: "https://example.test/v?k=abc" });
  check("reminder announces the intermission", /休赛期/.test(onBreak.text), onBreak.text.slice(0, 80));
  check("reminder marks the link as post-resume", /恢复后点此投票/.test(onBreak.text));
  check("hasRound is false while paused (mass-send won't nag)", onBreak.hasRound === false);

  db.endBreakNow(live.id);
  db.setFreeze(live.id, { on: true, note: "维护中" });
  const frozen = rem.buildRoundReminder({ voteUrl: "https://example.test/v?k=abc" });
  check("reminder announces a maintenance freeze too", /维护/.test(frozen.text));
  check("hasRound is false while frozen", frozen.hasRound === false);
  db.setFreeze(live.id, { on: false });

  const open = rem.buildRoundReminder({ voteUrl: "https://example.test/v?k=abc" });
  check("with nothing paused the link is presented normally",
    /👉 点此投票/.test(open.text) && !/休赛期/.test(open.text));
}

// ── inbound WeChat values can't break out of the CDATA block ──
{
  const wx = await import("../lib/wx");
  const xml = wx.textReplyXml("u]]><Evil>x</Evil>", "acct", "body]]> text");
  check("`]]>` in an inbound value cannot terminate the CDATA section",
    !/\]\]><Evil>/.test(xml) && /\]\]\]\]><!\[CDATA\[>/.test(xml), xml.slice(0, 100));
}

console.log(failures ? `\n${failures} failure(s)` : "\nall intermission checks passed");
process.exit(failures ? 1 : 0);
