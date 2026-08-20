// Tie-break + replace + archive test — run with `npm run test:tiebreak`.
//
// 平票排序规则：先达到当前票数的排在前面，加票和撤票/作废都算「达到」的那一刻。
// 例：A 3 点到 10 票；B 5 点从 11 票被撤掉一票变成 10 票 → A 在前。
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "saimoe-tb-"));
process.env.DATA_DIR = DIR;
process.env.BACKUP_DIR = join(DIR, "backups");
process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

const db = await import("../lib/db");
const eng = await import("../lib/engine");
const backup = await import("../lib/backup");

let failures = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) console.log("  ok  " + label);
  else { console.error("FAIL " + label + (extra ? "  → " + extra : "")); failures++; }
};
const stamp = (cid: number, id: number, at: number) => {
  const d = db.readDb(); db.stampTally(d, cid, [id], at); db.writeDb(d);
};

db.ensureSchema();
const cid = db.createCompetition("tiebreak");
db.addCandidates(cid, [{ bgmId: "t1", name: "AAA" }, { bgmId: "t2", name: "BBB" }, { bgmId: "t3", name: "CCC" }]);
const [A, B, C] = db.readDb().candidates.filter((c) => c.competition_id === cid).map((c) => c.id);

// give all three the same tally
for (const id of [A, B, C]) for (let i = 0; i < 3; i++) db.toggleNomination(cid, id, `v_${id}_${i}`);
const tally = (id: number) => db.readDb().nominationVotes.filter((v) => v.competition_id === cid && v.candidate_id === id).length;
check("all three are tied on 3 votes", tally(A) === 3 && tally(B) === 3 && tally(C) === 3);

// force a known order of "when they reached 3": B first, then A, then C
const T0 = Date.UTC(2026, 0, 1, 3, 0);
stamp(cid, B, T0);
stamp(cid, A, T0 + 3600_000);
stamp(cid, C, T0 + 7200_000);

const rank = () => (eng.getState("nobody") as any).nomination.pool.map((p: any) => p.name);
check("tied candidates order by who reached the count first", rank().join(",") === "BBB,AAA,CCC", rank().join(","));

// a REVOKED vote also counts as "reaching" the current count, and it re-stamps to now
db.toggleNomination(cid, B, "extra_b");                 // B -> 4
check("B is now ahead on votes", tally(B) === 4);
db.toggleNomination(cid, B, "extra_b");                 // revoked -> back to 3, stamped now
check("B is tied again after the revoke", tally(B) === 3);
check("the revoke pushes B behind the others (it reached 3 last)",
  rank().join(",") === "AAA,CCC,BBB", rank().join(","));

// admin voiding is the same: it changes the count, so it re-stamps
const vid = db.readDb().nominationVotes.find((v) => v.competition_id === cid && v.candidate_id === A)!.id!;
db.invalidateVoteIds(cid, [vid]);
check("A dropped to 2 after a void", tally(A) === 2);
check("A now ranks below the 3-vote candidates", rank().indexOf("AAA") === 2, rank().join(","));

// legacy rows (no tally_at) must not be reordered by the new rule
{
  const d = db.readDb();
  for (const c of d.candidates) if (c.competition_id === cid) c.tally_at = null;
  db.writeDb(d);
  const legacy = rank();
  check("with no timestamps at all the order stays alphabetical (old behaviour)",
    legacy.join(",") === "BBB,CCC,AAA", legacy.join(","));
}
// mixed: a stamped candidate sorts ahead of an unstamped one on the same count
stamp(cid, C, T0);
check("a stamped candidate outranks an unstamped one at equal votes",
  rank()[0] === "CCC", rank().join(","));

// ── replace keeps votes, group and seed ──
{
  const d = db.readDb();
  const row = d.candidates.find((c) => c.id === A)!;
  row.group_no = 2; row.seed = 7;
  db.writeDb(d);
  const before = tally(A);
  const r = db.replaceCandidate(cid, A, { bgmId: "c9999", name: "新角色", nameCn: "新角色中文", image: "https://lain.bgm.tv/x.jpg", subjectName: "新作品" });
  check("replace succeeds", !("error" in r));
  const after = db.readDb().candidates.find((c) => c.id === A)!;
  check("the database id is unchanged", after.id === A);
  check("votes are preserved", tally(A) === before, `${tally(A)} vs ${before}`);
  check("group and seed are preserved", after.group_no === 2 && after.seed === 7);
  check("identity and names were replaced", after.bgm_id === "c9999" && after.name_cn === "新角色中文");
  check("the old bgm id is kept as an alias", (after.aliases || []).includes("t1"));
  check("the stale origin verdict was cleared", after.jp_status == null);
  // replacing onto a character already in the pool must be refused, not silently duplicated
  const clash = db.replaceCandidate(cid, B, { bgmId: "c9999", name: "新角色" });
  check("replacing onto an existing pool entry is refused", "error" in clash && /合并/.test((clash as any).error));
}

// ── round archives are permanent (not subject to BACKUP_KEEP rotation) ──
{
  process.env.BACKUP_KEEP = "2";
  const a1 = backup.archiveRound("nomination");
  const a2 = backup.archiveRound("group:1");
  const a3 = backup.archiveRound("group:2");
  check("each round archive is written", !!a1 && !!a2 && !!a3 && existsSync(a3!));
  const dir = join(process.env.BACKUP_DIR!, "rounds");
  check("archives are NOT rotated away by BACKUP_KEEP",
    readdirSync(dir).filter((f) => f.endsWith(".json")).length === 3,
    `${readdirSync(dir).join(",")}`);
  check("archive names carry the round key", readdirSync(dir).some((f) => f.includes("group-1")));
  // periodic snapshots still rotate, and live in a different place
  backup.backupNow(); backup.backupNow(); backup.backupNow();
  const snaps = readdirSync(process.env.BACKUP_DIR!).filter((f) => f.startsWith("saimoe-") && f.endsWith(".json"));
  check("periodic snapshots still respect BACKUP_KEEP", snaps.length <= 2, `${snaps.length}`);

  process.env.BACKUP_ENABLED = "false";
  check("the master switch disables round archives", backup.archiveRound("group:3") === null);
  delete process.env.BACKUP_ENABLED;
}

// ── eliminated characters drop out of the admin data-gap inventory ──
{
  const obs = await import("../lib/observe");
  const d = db.readDb();
  d.candidates.find((c) => c.id === B)!.eliminated = true;
  db.writeDb(d);
  const g = obs.dataGaps(cid);
  check("eliminated characters are not listed", !g.rows.some((r) => r.id === B));
  check("the inventory reports how many it hid", g.hiddenEliminated === 1, `${g.hiddenEliminated}`);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall tie-break / replace / archive checks passed");
process.exit(failures ? 1 : 0);
