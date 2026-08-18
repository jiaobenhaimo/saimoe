// Smart-void planner test — run with `npm run test:fraud-plan`.
//
// Encodes the two rules the operator asked for, which used to conflict:
//   (a) 每个角色留一张票 — after voiding, every character keeps exactly one vote from the cluster.
//   (b) 确保每个身份本轮都被封禁 — every identity in the cluster is banned for this round.
//
// The scenario is the operator's own: one device votes for A 5x, B 6x, C 8x, D 2x, E 1x
// (22 votes) and must come out as A1 B1 C1 D1 E1 (5 kept, 17 deleted), with every identity
// banned. The old planner satisfied (b) by deleting one more vote from any identity that had
// escaped (a) — which deleted E's only vote and left E on zero, breaking (a).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWN = !process.env.SMOKE_DATA_DIR;
process.env.DATA_DIR = process.env.SMOKE_DATA_DIR || mkdtempSync(join(tmpdir(), "saimoe-fraud-"));
if (OWN) process.on("exit", () => { try { rmSync(process.env.DATA_DIR!, { recursive: true, force: true }); } catch {} });

const db = await import("../lib/db");

let failures = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) console.log("  ok  " + label);
  else { console.error("FAIL " + label + (extra ? "  → " + extra : "")); failures++; }
};

const BUCKET = "d".repeat(64); // the shared device signature that ties the cluster together
const cid = db.createCompetition("fraud-plan");
db.ensureSchema();

// Five characters. Two of them share a display NAME on purpose: name collisions are common in
// saimoe (同名角色), and the planner must key on candidate id, not on the rendered label.
db.addCandidates(cid, [
  { bgmId: "c1", name: "A" }, { bgmId: "c2", name: "B" }, { bgmId: "c3", name: "C" },
  { bgmId: "c4", name: "D" }, { bgmId: "c5", name: "A" }, // c5 renders as "A" too
]);
const pool = db.readDb().candidates.filter((c) => c.competition_id === cid);
const idOf = (bgm: string) => pool.find((c) => c.bgm_id === bgm)!.id;
const [A, B, C, D, E] = ["c1", "c2", "c3", "c4", "c5"].map(idOf);

// The stuffing pattern. Each vote comes from its own voter_id (cache cleared between votes) but
// they all carry the same device bucket, which is how the cluster is detected.
const plan: [number, number][] = [[A, 5], [B, 6], [C, 8], [D, 2], [E, 1]];
let n = 0;
for (const [cand, times] of plan)
  for (let i = 0; i < times; i++)
    db.toggleNomination(cid, cand, `fp_v${++n}`, { bucket: BUCKET, ip: "203.0.113.9" });

const TOTAL = plan.reduce((t, [, k]) => t + k, 0);
check(`${TOTAL} stuffed votes recorded`, db.readDb().nominationVotes.length === TOTAL);

// ── the plan ──
const p = db.planSmartInvalidate(cid, "bucket", BUCKET);
check("deletes 17, keeps 5", p.ids.length === TOTAL - 5 && p.keptPerBallot === 5,
  `deletes=${p.ids.length} keeps=${p.keptPerBallot}`);

// (b) every identity is accounted for and marked banned
check(`all ${TOTAL} identities are in the plan`, p.perIdentity.length === TOTAL);
check("every identity is banned", p.perIdentity.every((i) => i.banned));
// E's single voter keeps its vote, so it must appear in banOnly rather than losing a vote
check("the identity whose vote is kept is banned without deletion",
  p.banOnly.length === 5 && p.banOnly.every((b) => b.bucket === BUCKET),
  `banOnly=${p.banOnly.length}`);

// ── execute, then verify (a) actually holds on disk ──
const removed = db.invalidateVoteIds(cid, p.ids, p.banOnly);
check("removed count matches the plan", removed === p.ids.length);

const left = db.readDb().nominationVotes.filter((v) => v.competition_id === cid);
const perCand = new Map<number, number>();
for (const v of left) perCand.set(v.candidate_id, (perCand.get(v.candidate_id) || 0) + 1);
check("exactly 5 votes survive", left.length === 5, `left=${left.length}`);
for (const [cand, label] of [[A, "A"], [B, "B"], [C, "C"], [D, "D"], [E, "E"]] as [number, string][])
  check(`character ${label} keeps exactly 1 vote`, perCand.get(cand) === 1, `got ${perCand.get(cand) ?? 0}`);
// This is the regression the operator hit: E had a single vote and used to be wiped to zero.
check("the single-vote character is NOT zeroed", (perCand.get(E) ?? 0) === 1);
// And the collision case: c5 renders as "A" but must be tracked separately from c1.
check("same-named characters are not merged", perCand.get(A) === 1 && perCand.get(E) === 1);

// ── every identity is actually blocked this round ──
const round = db.roundKeyOf(db.readDb().competitions.find((c) => c.id === cid));
let blocked = 0, unblocked: string[] = [];
for (let i = 1; i <= TOTAL; i++) {
  const s = db.voterSanction({ voterId: `fp_v${i}`, bucket: BUCKET }, round);
  if (s?.blockedThisRound) blocked++; else unblocked.push(`fp_v${i}`);
}
check(`all ${TOTAL} identities blocked this round`, blocked === TOTAL, `unblocked: ${unblocked.join(",")}`);

// The survivor's owner is blocked. Its reported count is 17, not 0 — and that is correct:
// voterSanction matches on voter_id OR device bucket (deliberately, so clearing storage and
// getting a new voter_id can't shake off a ban), and this device really did have 17 votes
// voided. Reporting the device-level number to someone sitting on that device is accurate.
const kept = left.find((v) => v.candidate_id === E)!;
const ks = db.voterSanction({ voterId: kept.voter_id, bucket: BUCKET }, round);
check("survivor's owner is blocked", ks?.blockedThisRound === true);
check("survivor's owner sees the device-level voided count", (ks?.count ?? -1) === TOTAL - 5, `count=${ks?.count}`);

// ── the count === 0 path: ban with nothing deleted ──
// Void by IDENTITY (not device) for someone whose single vote is the one the rules keep. Nothing
// of theirs is deleted, so the ban must still land, and the count must be 0 — which is what
// warn.blocked0 exists for. Before the fix, voterSanction returned null on count 0 and this
// identity walked away unbanned.
const cid3 = db.createCompetition("ban-only");
db.addCandidates(cid3, [{ bgmId: "z1", name: "Z" }]);
const Z = db.readDb().candidates.find((c) => c.competition_id === cid3 && c.bgm_id === "z1")!.id;
db.toggleNomination(cid3, Z, "fp_lonely", { bucket: null, ip: "198.51.100.4" });
const p4 = db.planSmartInvalidate(cid3, "voter", "fp_lonely");
check("lone vote is kept, nothing to delete", p4.ids.length === 0 && p4.keptPerBallot === 1);
check("lone voter is queued for ban-only", p4.banOnly.length === 1 && p4.banOnly[0].voterId === "fp_lonely");
db.invalidateVoteIds(cid3, p4.ids, p4.banOnly);
check("the kept vote is still there", db.readDb().nominationVotes.filter((v) => v.competition_id === cid3).length === 1);
const round3 = db.roundKeyOf(db.readDb().competitions.find((c) => c.id === cid3));
const ls = db.voterSanction({ voterId: "fp_lonely", bucket: null }, round3);
check("ban-only identity IS blocked (regression: used to return null)", ls?.blockedThisRound === true);
check("ban-only identity reports 0 voided votes", ls?.count === 0, `count=${ls?.count}`);

// ── a character voted on two different ballots keeps one vote PER ballot ──
// Same character, two matchups: both votes are legitimate, so neither is a duplicate.
const cid2 = db.createCompetition("two-ballots");
db.addCandidates(cid2, [{ bgmId: "x1", name: "X" }, { bgmId: "x2", name: "Y" }]);
const p2 = db.readDb().candidates.filter((c) => c.competition_id === cid2);
const X = p2.find((c) => c.bgm_id === "x1")!.id, Y = p2.find((c) => c.bgm_id === "x2")!.id;
const d2 = db.readDb();
d2.matchups.push(
  { id: ++d2.seq.matchup, competition_id: cid2, stage: "knockout", round_no: 1, group_no: null, slot: 0, a_id: X, b_id: Y, winner_id: null, decided: false },
  { id: ++d2.seq.matchup, competition_id: cid2, stage: "knockout", round_no: 2, group_no: null, slot: 0, a_id: X, b_id: Y, winner_id: null, decided: false });
db.writeDb(d2);
const [m1, m2] = db.readDb().matchups.filter((m) => m.competition_id === cid2).map((m) => m.id);
db.castMatchVote(cid2, m1, "fp_solo", X, { bucket: BUCKET, ip: "203.0.113.9" });
db.castMatchVote(cid2, m2, "fp_solo", X, { bucket: BUCKET, ip: "203.0.113.9" });
const p3 = db.planSmartInvalidate(cid2, "bucket", BUCKET);
check("one vote per ballot for the same character is not a duplicate", p3.ids.length === 0,
  `would delete ${p3.ids.length}`);

console.log(failures ? `\n${failures} failure(s)` : "\nall smart-void checks passed");
process.exit(failures ? 1 : 0);
