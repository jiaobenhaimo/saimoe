// Backwards-compatibility test — run with `npm run test:compat`.
//
// Guards the thing that matters most when deploying mid-tournament: an EXISTING data file, written
// by the version of this app that ran before the upgrade, must keep working unchanged. Concretely
// that file has:
//   - candidates with NO jp_status / jp_reason / jp_checked_at fields
//   - votes with NO id, no device_bucket, no ip, no created_at
//   - a competition with no freeze_*, no blocked_*, no group_matchday_starts
//   - no sanctions / fraudReviewed arrays at all
//
// The failure this is written to catch: treating "field absent" as "flagged", which would dump
// every character already in the pool into the admin review queue the moment the new build ships.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "saimoe-compat-"));
process.env.DATA_DIR = DIR;
process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

// A data file in the OLD shape, as an in-flight league would have on disk.
const legacy = {
  seq: { competition: 1, candidate: 3, matchup: 0, comment: 1, audit: 0 }, // note: no `vote` key
  competitions: [{
    id: 1, title: "上一届", description: null, short_name: null, phase: "nomination",
    target_size: null, groups_count: null, champion_id: null, ko_round: null, created_at: 1_700_000_000_000,
    nom_ends_at: null, group_ends_at: null, ko_round_ends_at: null, auto_size: null,
    round_hours: null, postpone_days: null, nom_user_limit: null, nom_min_votes: null,
    group_matchday: null, group_matchday_count: null, group_per_round: null,
    group_round_days: null, group_round_ends_at: null, ko_target: null,
    ko_seed_ids: null, playoff_slots: null,
  }],
  candidates: [
    { id: 1, competition_id: 1, bgm_id: "c1", name: "旧角色甲", name_cn: "旧角色甲", image: null, group_no: null, seed: null, eliminated: false, subject_name: "旧作品", added_by: "fp_aaa", name_en: null },
    { id: 2, competition_id: 1, bgm_id: "c2", name: "旧角色乙", name_cn: null, image: null, group_no: null, seed: null, eliminated: false, subject_name: null, added_by: null, name_en: null },
    { id: 3, competition_id: 1, bgm_id: "c3", name: "旧角色丙", name_cn: null, image: null, group_no: null, seed: null, eliminated: false, subject_name: null, added_by: null, name_en: null },
  ],
  matchups: [],
  nominationVotes: [
    { competition_id: 1, candidate_id: 1, voter_id: "fp_aaa" },       // no id / meta / timestamp
    { competition_id: 1, candidate_id: 1, voter_id: "fp_bbb" },
    { competition_id: 1, candidate_id: 2, voter_id: "fp_aaa" },
  ],
  matchVotes: [],
  approvalVotes: [],
  comments: [{ id: 1, competition_id: 1, matchup_id: 0, voter_id: "fp_aaa", name: "旧评论者", text: "旧评论", created_at: 1_700_000_100_000 }],
  auditLog: [],
  // deliberately absent: sanctions, fraudReviewed
};
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, "saimoe.json"), JSON.stringify(legacy));

const db = await import("../lib/db");
const eng = await import("../lib/engine");

let failures = 0;
const check = (label: string, cond: boolean) => {
  if (cond) console.log("  ok  " + label);
  else { console.error("FAIL " + label); failures++; }
};

// ── the old file loads at all ──
const loaded = db.readDb();
check("legacy file loads", loaded.competitions.length === 1 && loaded.candidates.length === 3);
check("missing seq.vote defaults to 0, not NaN", Number.isFinite(loaded.seq.vote));
check("missing sanctions array is normalised", Array.isArray(loaded.sanctions));
check("missing fraudReviewed array is normalised", Array.isArray(loaded.fraudReviewed));

// ── votes without ids get backfilled so per-vote invalidation works on old data ──
check("legacy votes are given ids", loaded.nominationVotes.every((v: any) => typeof v.id === "number" && v.id > 0));
check("backfilled ids are unique", new Set(loaded.nominationVotes.map((v: any) => v.id)).size === 3);

// ── state projects, and tallies are right ──
const st: any = eng.getState("fp_aaa");
check("state renders for a legacy competition", st.competition?.id === 1 && st.nomination?.pool?.length === 3);
const byId = new Map(st.nomination.pool.map((p: any) => [p.id, p]));
check("legacy nomination tallies preserved", (byId.get(1) as any).votes === 2 && (byId.get(2) as any).votes === 1);
check("voter's own votes still recognised", (byId.get(1) as any).voted === true && (byId.get(3) as any).voted === false);
check("self-nominated flag preserved", (byId.get(1) as any).mine === true);

// ── THE important one: no legacy candidate is treated as awaiting origin review ──
check("no legacy candidate is flagged for review", st.nomination.pool.every((p: any) => p.jpPending !== true));
check("review queue is empty for legacy data", db.listJpFlagged(1).length === 0);
check("flagged count is zero for legacy data", db.jpFlaggedCount(1) === 0);

// ── new candidates DO carry a verdict, and only the negative one queues up ──
db.addCandidates(1, [
  { bgmId: "c10", name: "新角色-通过", jpStatus: "ok", jpReason: "作品 #1 带「日本」标签" },
  { bgmId: "c11", name: "新角色-待复核", jpStatus: "flagged", jpReason: "关联作品均无「日本」标签" },
  { bgmId: "c12", name: "新角色-查不到", jpStatus: "unknown", jpReason: "上游超时" },
], "fp_new");
check("batch insert added all three", db.readDb().candidates.length === 6);
const q = db.listJpFlagged(1);
check("only the definitively-negative one is queued", q.length === 1 && q[0].bgmId === "c11");
check("'unknown' (upstream failed) is NOT queued", !q.some((x) => x.bgmId === "c12"));

// ── batch insert dedupes against existing rows and within the batch ──
const dup = db.addCandidates(1, [
  { bgmId: "c1", name: "旧角色甲" },     // already present
  { bgmId: "c99", name: "新的" },
  { bgmId: "c99", name: "新的重复" },     // duplicate inside the batch
], "fp_new");
check("batch insert dedupes", dup.added === 1 && dup.skipped === 2);

// ── admin review clears the flag without deleting the character ──
const flaggedId = q[0].id;
check("clearJpFlag succeeds", db.clearJpFlag(1, flaggedId) === true);
check("cleared character leaves the queue", db.listJpFlagged(1).length === 0);
check("cleared character stays in the pool", db.readDb().candidates.some((c) => c.id === flaggedId));
check("a later re-check cannot un-clear an admin decision",
  (db.setJpStatus(1, flaggedId, "flagged", "re-check"), db.readDb().candidates.find((c) => c.id === flaggedId)?.jp_status === "cleared"));

// ── legacy rows are untouched on disk after all these writes ──
const after = JSON.parse(readFileSync(join(DIR, "saimoe.json"), "utf8"));
const c2 = after.candidates.find((c: any) => c.bgm_id === "c2");
check("legacy candidate gained no jp_status", c2.jp_status == null);
check("legacy comment survived", after.comments.length === 1 && after.comments[0].text === "旧评论");

console.log(failures ? `\n${failures} failure(s)` : "\nall compatibility checks passed");
process.exit(failures ? 1 : 0);
