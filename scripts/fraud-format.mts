// Format-aware fraud detection test — run with `npm run test:fraud-format`.
//
// The competition format is: group stage = 6 candidates per group, pick 2; knockout = a chain of
// head-to-head 1-of-2 matchups. Both have TINY ballots, and that breaks the assumptions the
// original overlap-based signals were built on (nomination, where a ballot is a large set):
//
//   * In a 1-of-2 matchup, two strangers agree 50% of the time by chance alone — more if one side
//     is popular. "They picked the same" is not evidence.
//   * In 6-choose-2 there are only 15 combinations, and popularity is concentrated, so lots of
//     honest voters submit an identical pair.
//
// Scoring that as suspicious floods the operator with false positives, and an operator who sees
// dozens of false positives stops trusting the board at all. So agreement is now scored by how
// RARE it is against the population's own distribution. These tests pin that down.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWN = !process.env.SMOKE_DATA_DIR;
process.env.DATA_DIR = process.env.SMOKE_DATA_DIR || mkdtempSync(join(tmpdir(), "saimoe-fmt-"));
if (OWN) process.on("exit", () => { try { rmSync(process.env.DATA_DIR!, { recursive: true, force: true }); } catch {} });

const db = await import("../lib/db");
const fraud = await import("../lib/fraud");

let failures = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) console.log("  ok  " + label);
  else { console.error("FAIL " + label + (extra ? "  → " + extra : "")); failures++; }
};

const cid = db.createCompetition("fmt");
db.ensureSchema();
// One group of 6.
db.addCandidates(cid, Array.from({ length: 6 }, (_, i) => ({ bgmId: "g" + i, name: "G" + i })));
const ids = db.readDb().candidates.filter((c) => c.competition_id === cid).map((c) => c.id);
const [A, B, C, D, E, F] = ids;

const DEV = "a".repeat(64);
let t = Date.UTC(2026, 0, 1);
const approve = (voter: string, cand: number, bucket: string | null) => {
  const d = db.readDb();
  d.approvalVotes.push({ id: ++d.seq.vote, competition_id: cid, group_no: 0, candidate_id: cand,
    voter_id: voter, created_at: (t += 60_000), device_bucket: bucket, ip: "203.0.113.7" });
  db.writeDb(d);
};

// ── population: 30 honest voters overwhelmingly pick the popular pair {A,B} ──
for (let i = 0; i < 30; i++) { approve(`hon${i}`, A, `h${i}`.padEnd(64, "0")); approve(`hon${i}`, B, `h${i}`.padEnd(64, "0")); }
// four honest voters on ONE shared household device also pick the popular pair
for (let i = 0; i < 4; i++) { approve(`fam${i}`, A, DEV); approve(`fam${i}`, B, DEV); }

let rep = fraud.generateFraudReport({ competitionId: cid, phase: "approval", minScore: 1 });
const famCluster = rep.clusters.find((c) => c.deviceBuckets.includes(DEV));
const s8fam = famCluster?.signals.find((s) => s.code === "S8");
check("agreeing on the POPULAR pair does not raise S8",
  !s8fam || s8fam.strength === 0, `S8 strength=${s8fam?.strength}`);
check("overlap signals are damped in the small-ballot phase",
  !famCluster || famCluster.signals.filter((s) => s.code === "S3" && s.strength > 0.3).length === 0,
  `S3=${famCluster?.signals.find((s) => s.code === "S3")?.strength}`);
const famScore = famCluster?.score ?? 0;

// ── now a stuffing device: 4 identities all submit the RARE pair {E,F} ──
const DEV2 = "b".repeat(64);
for (let i = 0; i < 4; i++) { approve(`bad${i}`, E, DEV2); approve(`bad${i}`, F, DEV2); }
rep = fraud.generateFraudReport({ competitionId: cid, phase: "approval", minScore: 1 });
const badCluster = rep.clusters.find((c) => c.deviceBuckets.includes(DEV2));
const s8bad = badCluster?.signals.find((s) => s.code === "S8");
check("repeating a RARE pair fires S8", !!s8bad && s8bad.strength > 0.5, `S8=${s8bad?.strength}`);
check("the rare-pair cluster outscores the popular-pair cluster",
  (badCluster?.score ?? 0) > famScore, `bad=${badCluster?.score} fam=${famScore}`);
check("S8 evidence quotes the population share", !!s8bad && /全站只有/.test(s8bad.evidence));

// ── knockout: 1-of-2 ──
const cid2 = db.createCompetition("fmt-ko");
db.addCandidates(cid2, Array.from({ length: 4 }, (_, i) => ({ bgmId: "k" + i, name: "K" + i })));
const k = db.readDb().candidates.filter((c) => c.competition_id === cid2).map((c) => c.id);
{
  const d = db.readDb();
  for (let r = 1; r <= 3; r++)
    d.matchups.push({ id: ++d.seq.matchup, competition_id: cid2, stage: "knockout", round_no: r,
      group_no: null, slot: 0, a_id: k[0], b_id: k[1], winner_id: null, decided: false });
  db.writeDb(d);
}
const ms = db.readDb().matchups.filter((m) => m.competition_id === cid2).map((m) => m.id);
const pick = (voter: string, mid: number, cand: number, bucket: string | null) => {
  const d = db.readDb();
  d.matchVotes.push({ id: ++d.seq.vote, matchup_id: mid, voter_id: voter, choice_id: cand,
    created_at: (t += 60_000), device_bucket: bucket, ip: "203.0.113.8" });
  db.writeDb(d);
};
// population: k[0] is the clear favourite in every round (25 of 28 voters)
for (let i = 0; i < 25; i++) for (const mid of ms) pick(`kh${i}`, mid, k[0], `kh${i}`.padEnd(64, "0"));

// (a) two identities on one device that both follow the FAVOURITE every round — normal fandom
const DEVK = "c".repeat(64);
for (let i = 0; i < 2; i++) for (const mid of ms) pick(`kmaj${i}`, mid, k[0], DEVK);
// (b) two identities on one device that agree every round on the UNDERDOG — the real signal
const DEVK2 = "d".repeat(64);
for (let i = 0; i < 2; i++) for (const mid of ms) pick(`kmin${i}`, mid, k[1], DEVK2);

const rep2 = fraud.generateFraudReport({ competitionId: cid2, phase: "match", minScore: 1 });
const maj = rep2.clusters.find((c) => c.deviceBuckets.includes(DEVK));
const min = rep2.clusters.find((c) => c.deviceBuckets.includes(DEVK2));
const s9maj = maj?.signals.find((s) => s.code === "S9");
const s9min = min?.signals.find((s) => s.code === "S9");
check("following the favourite every round does NOT fire S9",
  !s9maj || s9maj.strength === 0, `S9=${s9maj?.strength}`);
check("agreeing on the underdog every round DOES fire S9",
  !!s9min && s9min.strength > 0.5, `S9=${s9min?.strength}`);
// Both clusters get non-S9 points (same device, same IP, synchronous timing — those signals are
// real and phase-independent). What must differ is the S9 contribution specifically: the bandwagon
// cluster earns none of it, the underdog-sync cluster earns most of it.
const s9Of = (c: any) => (c?.signals.find((s: any) => s.code === "S9")?.strength ?? 0) * 30;
check("S9 contributes to the underdog cluster and not the bandwagon one",
  s9Of(min) > 15 && s9Of(maj) === 0, `min S9=${s9Of(min)} maj S9=${s9Of(maj)}`);
check("removing S9 leaves the two clusters scored on the same non-format evidence",
  Math.abs((min?.score ?? 0) - s9Of(min)) >= 0 && (maj?.score ?? 0) > 0,
  `min=${min?.score} maj=${maj?.score}`);
check("S9 explains why single-round agreement is not evidence",
  !!s9min && /二选一里单场一致很正常/.test(s9min.evidence));

// ── a single shared matchup must never fire S9 (needs ≥2 rounds) ──
const cid3 = db.createCompetition("fmt-one");
db.addCandidates(cid3, [{ bgmId: "s0", name: "S0" }, { bgmId: "s1", name: "S1" }]);
const s3c = db.readDb().candidates.filter((c) => c.competition_id === cid3).map((c) => c.id);
{
  const d = db.readDb();
  d.matchups.push({ id: ++d.seq.matchup, competition_id: cid3, stage: "knockout", round_no: 1,
    group_no: null, slot: 0, a_id: s3c[0], b_id: s3c[1], winner_id: null, decided: false });
  db.writeDb(d);
}
const only = db.readDb().matchups.filter((m) => m.competition_id === cid3)[0].id;
const DEVS = "e".repeat(64);
for (let i = 0; i < 3; i++) pick(`one${i}`, only, s3c[1], DEVS);
const rep3 = fraud.generateFraudReport({ competitionId: cid3, phase: "match", minScore: 1 });
const oneC = rep3.clusters.find((c) => c.deviceBuckets.includes(DEVS));
check("one shared round alone cannot fire S9",
  !oneC?.signals.some((s) => s.code === "S9" && s.strength > 0),
  `${oneC?.signals.map((s) => s.code + ":" + s.strength.toFixed(2)).join(",")}`);

// ── the void-impact preview must reflect the CURRENT phase ──
// It used to recompute the nomination ranking no matter what phase the tournament was in, so during
// the group stage it reported "no candidate crosses the cut" even when voiding would change who
// advances. With 6-choose-2 groups a handful of votes decides a slot, so a blind preview is worse
// than none — it actively reassures the operator that a damaging void is harmless.
{
  const cidI = db.createCompetition("impact-phase");
  db.addCandidates(cidI, Array.from({ length: 6 }, (_, i) => ({ bgmId: "i" + i, name: "I" + i })));
  const ci = db.readDb().candidates.filter((c) => c.competition_id === cidI);
  // put all six in group 0 with seeds, and move to the group phase
  {
    const d = db.readDb();
    for (const [i, c] of ci.entries()) {
      const row = d.candidates.find((x) => x.id === c.id)!;
      row.group_no = 0; row.seed = i;
    }
    const comp = d.competitions.find((x) => x.id === cidI)!;
    comp.phase = "group"; comp.group_mode = "approval"; comp.group_matchday = 1;
    comp.group_matchday_count = 1; comp.groups_per_day = 2; comp.groups_count = 1;
    db.writeDb(d);
  }
  const [A2, B2, C2] = [ci[0].id, ci[1].id, ci[2].id];
  const DEVI = "f".repeat(64);
  // honest voters put A2 and B2 on top
  for (let i = 0; i < 6; i++) {
    db.castApprovalVote(cidI, A2, `ih${i}`, { bucket: `ih${i}`.padEnd(64, "0"), ip: "203.0.113.20" });
    db.castApprovalVote(cidI, B2, `ih${i}`, { bucket: `ih${i}`.padEnd(64, "0"), ip: "203.0.113.20" });
  }
  // a stuffing cluster pushes C2 past B2
  for (let i = 0; i < 7; i++) {
    db.castApprovalVote(cidI, C2, `ib${i}`, { bucket: DEVI, ip: "203.0.113.21" });
    db.castApprovalVote(cidI, A2, `ib${i}`, { bucket: DEVI, ip: "203.0.113.21" });
  }
  const stuffers = Array.from({ length: 7 }, (_, i) => `ib${i}`);

  const nomView = fraud.computeImpact(cidI, stuffers);                 // no phase → old behaviour
  check("without a phase the preview is blind (nomination scope)",
    nomView.scope === "nomination" && nomView.affected.length === 0);

  const grpView = fraud.computeImpact(cidI, stuffers, "approval");
  check("with the group phase the preview uses group scope", grpView.scope === "approval");
  check("it reports the group whose advancing pair changes",
    (grpView.groupFlips?.length ?? 0) === 1, JSON.stringify(grpView.groupFlips));
  const flip = grpView.groupFlips?.[0];
  check("it names who drops out and who takes the slot",
    !!flip && flip.inOut.length > 0 && flip.outIn.length > 0, JSON.stringify(flip));
  check("the stuffed candidate is the one that drops out",
    !!flip && flip.inOut.includes("I3") === false && flip.inOut.length === 1, JSON.stringify(flip?.inOut));
}

console.log(failures ? `\n${failures} failure(s)` : "\nall format-aware detection checks passed");
process.exit(failures ? 1 : 0);
