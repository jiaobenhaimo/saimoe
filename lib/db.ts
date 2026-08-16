import fs from "fs";
import path from "path";

/**
 * Local JSON-file store (no external database).
 *
 * The file is the single source of truth. Every operation does a synchronous
 * read-modify-write, which — because Node runs our handler code single-threaded
 * with no `await` in the middle of a mutation — is atomic per instance: two
 * concurrent votes can't lose each other's write.
 *
 * Caveats (inherent to local storage): the container filesystem is EPHEMERAL,
 * so data resets on redeploy/restart unless DATA_DIR points at a mounted
 * persistent volume; and multiple instances each keep their own file, so run a
 * SINGLE instance.
 */

export type Phase = "nomination" | "group" | "playoff" | "knockout" | "finished";

export interface Competition {
  id: number; title: string; description: string | null; short_name: string | null; phase: Phase;
  title_en?: string | null; title_ja?: string | null; desc_en?: string | null; desc_ja?: string | null; short_en?: string | null; short_ja?: string | null;
  target_size: number | null; groups_count: number | null;
  champion_id: number | null; ko_round: number | null; created_at: number;
  third_place?: boolean | null; // 是否进行季军战(默认 true)
  // ── timed schedule (epoch ms; null = not scheduled) ──
  nom_ends_at: number | null; group_ends_at: number | null; ko_round_ends_at: number | null;
  auto_size: number | null;
  round_hours: number | null; postpone_days: number | null;
  // ── nomination constraints (null/0 = unlimited) ──
  nom_user_limit: number | null; nom_min_votes: number | null;
  // ── group stage matchdays (round-robin split into rounds) ──
  group_matchday: number | null; group_matchday_count: number | null;
  group_per_round: number | null; group_round_days: number | null; group_round_ends_at: number | null;
  group_day_cap: number | null;   // 每比赛日最多对局数(null=默认 4)
  group_size: number | null;      // 每组人数(null=默认 4;余数补进弱组成 G+1 人组)
  group_mode: "approval" | "rr" | null; // 小组赛玩法:approval=每人组内投2票取前二(默认);rr=两两对阵循环赛
  groups_per_day: number | null;  // approval 模式:每个比赛日开放几个组投票(默认 2)
  group_started_at: number | null; // 小组赛开赛时间(legacy anchor,仅供旧数据兜底用)
  // 每个比赛日"真实"开始的时间戳(在 startGroups / advanceGroupMatchday 发生的那一刻记录),
  // 作为"日期"列的事实来源——已发生的比赛日永远读这里,不会因为之后调整节奏(setPace)
  // 或提前/延后手动结算而回溯性地改写历史日期。尚未到达的比赛日没有 entry,由 mdDate()
  // 用"最后一个已知比赛日 + 当前节奏"来估算(这部分会随节奏调整而更新,这是正确行为)。
  group_matchday_starts: Record<number, number> | null;
  ko_target: number | null;
  ko_seed_ids: number[] | null; playoff_slots: number | null;
}
export interface Candidate {
  id: number; competition_id: number; bgm_id: string; name: string; name_cn: string | null;
  image: string | null; group_no: number | null; seed: number | null; eliminated: boolean;
  subject_name: string | null; added_by: string | null; name_en: string | null;
  // epoch ms a *user* self-nominated this (null for admin/subject-imported bulk → never swept)
  nominated_at?: number | null;
}
export interface Matchup {
  id: number; competition_id: number; stage: "group" | "knockout" | "playoff"; round_no: number;
  group_no: number | null; slot: number; a_id: number; b_id: number;
  winner_id: number | null; decided: boolean; matchday?: number | null; bronze?: boolean; // bronze=true: 季军战(半决赛两败者)
}
interface NominationVote { competition_id: number; candidate_id: number; voter_id: string; created_at?: number; device_bucket?: string | null; ip?: string | null; }
interface MatchVote { matchup_id: number; voter_id: string; choice_id: number; created_at?: number; device_bucket?: string | null; ip?: string | null; }
/** A group-stage approval vote (approval mode): one row per (voter, group, candidate). Max 2 per (voter, group). */
interface ApprovalVote { competition_id: number; group_no: number; candidate_id: number; voter_id: string; created_at?: number; device_bucket?: string | null; ip?: string | null; }

/** Non-identifying-by-default metadata attached to a vote. `bucket` is a coarse
 *  cross-browser device hint; `ip` is the caller's forwarded IP. Both are used only to
 *  FLAG (and, if an operator chooses, invalidate) suspicious voting — never to dedup. */
export type VoteMeta = { bucket?: string | null; ip?: string | null };

/** One row in the admin audit trail. */
export interface AuditEntry { id: number; ts: number; action: string; summary: string; phase: string | null; }
export interface Comment {
  id: number; competition_id: number; matchup_id: number; voter_id: string;
  name: string; text: string; created_at: number;
}

export interface DB {
  seq: { competition: number; candidate: number; matchup: number; comment: number; audit: number };
  competitions: Competition[];
  candidates: Candidate[];
  matchups: Matchup[];
  nominationVotes: NominationVote[];
  matchVotes: MatchVote[];
  approvalVotes: ApprovalVote[];
  comments: Comment[];
  auditLog: AuditEntry[];
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "saimoe.json");

/** Absolute path of the live data file (used by the backup job). */
export function dataFilePath(): string { return FILE; }

function blank(): DB {
  return { seq: { competition: 0, candidate: 0, matchup: 0, comment: 0, audit: 0 }, competitions: [], candidates: [], matchups: [], nominationVotes: [], matchVotes: [], approvalVotes: [], comments: [], auditLog: [] };
}
function normalize(o: any): DB {
  if (!o || typeof o !== "object") return blank();
  const b = blank();
  return {
    seq: {
      competition: Number(o?.seq?.competition) || 0,
      candidate: Number(o?.seq?.candidate) || 0,
      matchup: Number(o?.seq?.matchup) || 0,
      comment: Number(o?.seq?.comment) || 0,
      audit: Number(o?.seq?.audit) || 0,
    },
    competitions: Array.isArray(o.competitions) ? o.competitions : b.competitions,
    candidates: Array.isArray(o.candidates) ? o.candidates : b.candidates,
    matchups: Array.isArray(o.matchups) ? o.matchups : b.matchups,
    nominationVotes: Array.isArray(o.nominationVotes) ? o.nominationVotes : b.nominationVotes,
    matchVotes: Array.isArray(o.matchVotes) ? o.matchVotes : b.matchVotes,
    approvalVotes: Array.isArray(o.approvalVotes) ? o.approvalVotes : b.approvalVotes,
    comments: Array.isArray(o.comments) ? o.comments : b.comments,
    auditLog: Array.isArray(o.auditLog) ? o.auditLog : b.auditLog,
  };
}

/** Read the whole store from disk (or a blank store if the file is absent).
 *  Cached by file mtime so repeated reads in one process skip the disk read;
 *  always returns a deep clone, so callers can mutate freely before writeDb().
 *  A corrupt/partial file is quarantined (renamed aside) and logged, instead of
 *  silently starting blank and then overwriting the damaged data. */
/** Newest valid snapshot in BACKUP_DIR, or null. Parsed before being trusted, so a
 *  truncated/corrupt snapshot is skipped in favour of an older good one.
 *  (Env read directly rather than importing lib/backup, which imports this module.) */
function loadLatestBackup(): DB | null {
  const dir = process.env.BACKUP_DIR || "/mnt/sml-data";
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.startsWith("saimoe-") && f.endsWith(".json")).sort().reverse();
  } catch { return null; }
  for (const n of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.competitions)) {
        console.error(`saimoe: restoring data from backup ${n}`);
        return normalize(parsed);
      }
    } catch { /* try the next-older snapshot */ }
  }
  return null;
}

/** Recover the live store: newest good backup if there is one, else an empty store.
 *  Persists the restored copy so subsequent writes build on it rather than on blank. */
function recover(): DB {
  const restored = loadLatestBackup();
  if (!restored) return blank();
  try { persist(restored); } catch (e) { console.error("saimoe: could not persist restored data", e); }
  return restored;
}

let cache: { mtimeMs: number; db: DB } | null = null;
/** Snapshot → mtime it was read at. WeakMap so snapshots stay garbage-collectable.
 *  Lets writeDb() tell "this snapshot is stale" from "the cache moved on". */
const readStamp = new WeakMap<DB, number>();
export function readDb(): DB {
  try {
    const st = fs.statSync(FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) {
      const clone = structuredClone(cache.db);
      readStamp.set(clone, st.mtimeMs);
      return clone;
    }
    const db = normalize(JSON.parse(fs.readFileSync(FILE, "utf8")));
    cache = { mtimeMs: st.mtimeMs, db };
    const clone = structuredClone(db);
    readStamp.set(clone, st.mtimeMs);
    return clone;
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException)?.code === "ENOENT";
    try {
      if (!missing && fs.existsSync(FILE)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const quarantined = FILE + ".corrupt-" + ts;
        fs.renameSync(FILE, quarantined);
        console.error("saimoe: data file unreadable, moved to " + quarantined, e);
      }
    } catch {}
    // Ephemeral DATA_DIR (fresh container) or a corrupt file: rebuild from the
    // persistent backup mount rather than starting an empty tournament.
    const db = recover();
    const clone = structuredClone(db);
    try { readStamp.set(clone, fs.statSync(FILE).mtimeMs); } catch {}
    return clone;
  }
}
/** Persist the store atomically (write temp file, then rename), and refresh the cache.
 *
 *  Lost-update guard: every mutation is read-modify-write over the whole file. Today that's
 *  safe because each mutating helper does its readDb()→writeDb() synchronously (Node's single
 *  thread can't interleave sync fs calls), but the moment someone adds an `await` between the
 *  two, concurrent requests would silently overwrite each other's votes. So we verify the file
 *  hasn't changed since the read that produced this snapshot and throw loudly if it has,
 *  instead of quietly dropping votes. */
/** Raw durable write: temp file → fsync → rename → fsync(dir). Without the fsyncs a
 *  power loss can leave the rename visible but the bytes unwritten (empty/short file). */
function persist(db: DB): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + "." + process.pid + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(db));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, FILE);
  try { const dfd = fs.openSync(DATA_DIR, "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch {}
  try {
    const m = fs.statSync(FILE).mtimeMs;
    cache = { mtimeMs: m, db: structuredClone(db) };
    readStamp.set(db, m); // snapshot is now current → sequential writes of it are fine
  } catch { cache = null; }
}

export function writeDb(db: DB): void {
  const stamp = readStamp.get(db);
  if (stamp !== undefined) {
    let cur: number | null = null;
    try { cur = fs.statSync(FILE).mtimeMs; } catch { cur = null; }
    if (cur !== null && cur !== stamp)
      throw new Error("saimoe: concurrent modification detected (data file changed since read) — write aborted to avoid losing votes. Retry the operation.");
  }
  persist(db);
}

/** Re-run a read-modify-write helper if it lost a write race, so a concurrent voter
 *  gets their vote recorded instead of an error. Each attempt re-reads fresh state. */
export function retryOnConflict<T>(fn: () => T, tries = 5): T {
  for (let i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      const conflict = e instanceof Error && e.message.includes("concurrent modification");
      if (!conflict || i >= tries - 1) throw e;
    }
  }
}
/** Kept for API compatibility with the old DB layer; just ensures the dir exists. */
export function ensureSchema(): void {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

// ── route-level operations (each is an atomic read-modify-write) ──

export function createCompetition(title: string): number {
  const db = readDb();
  const id = ++db.seq.competition;
  db.competitions.push({ id, title, description: null, short_name: null, title_en: null, title_ja: null, desc_en: null, desc_ja: null, short_en: null, short_ja: null, phase: "nomination", target_size: null, groups_count: null, champion_id: null, ko_round: null, created_at: Date.now(), nom_ends_at: null, group_ends_at: null, ko_round_ends_at: null, auto_size: null, round_hours: null, postpone_days: null, nom_user_limit: null, nom_min_votes: null, group_matchday: null, group_matchday_count: null, group_per_round: null, group_round_days: null, group_round_ends_at: null, group_day_cap: null, group_size: null, group_mode: null, groups_per_day: null, group_started_at: null, group_matchday_starts: null, ko_target: null, ko_seed_ids: null, playoff_slots: null, third_place: null });
  writeDb(db);
  return id;
}

export function deleteCompetition(cid: number): void {
  const db = readDb();
  const matchIds = new Set(db.matchups.filter((m) => m.competition_id === cid).map((m) => m.id));
  db.competitions = db.competitions.filter((c) => c.id !== cid);
  db.candidates = db.candidates.filter((c) => c.competition_id !== cid);
  db.matchups = db.matchups.filter((m) => m.competition_id !== cid);
  db.nominationVotes = db.nominationVotes.filter((v) => v.competition_id !== cid);
  db.matchVotes = db.matchVotes.filter((v) => !matchIds.has(v.matchup_id));
  db.approvalVotes = db.approvalVotes.filter((v) => v.competition_id !== cid);
  db.comments = db.comments.filter((c) => c.competition_id !== cid);
  writeDb(db);
}

/** Insert a candidate; returns false if (competition, bgm_id) already exists. */
export function addCandidate(cid: number, bgmId: string, name: string, nameCn: string, image: string, subjectName = "", addedBy = "", nameEn = ""): boolean {
  const db = readDb();
  if (db.candidates.some((c) => c.competition_id === cid && c.bgm_id === bgmId)) return false;
  const id = ++db.seq.candidate;
  db.candidates.push({ id, competition_id: cid, bgm_id: bgmId, name, name_cn: nameCn || null, image: image || null, group_no: null, seed: null, eliminated: false, subject_name: subjectName || null, added_by: addedBy || null, name_en: nameEn || null, nominated_at: addedBy ? Date.now() : null });
  writeDb(db);
  return true;
}

/** A user removes a character THEY nominated, allowed only while it has zero nomination votes. */
export function removeOwnCandidate(cid: number, candidateId: number, voterId: string): { ok: true } | { error: string } {
  const db = readDb();
  const c = db.candidates.find((x) => x.id === candidateId && x.competition_id === cid);
  if (!c) return { error: "角色不存在。" };
  if ((c.added_by || "") !== voterId) return { error: "只能移除你自己提名的角色。" };
  const votes = db.nominationVotes.filter((v) => v.competition_id === cid && v.candidate_id === candidateId).length;
  if (votes > 0) return { error: "已经有人投票,无法移除。" };
  db.candidates = db.candidates.filter((x) => x.id !== candidateId);
  db.nominationVotes = db.nominationVotes.filter((v) => v.candidate_id !== candidateId);
  writeDb(db);
  return { ok: true };
}

/** Set of candidate ids in this competition that have at least one nomination vote. */
function votedCandidateIds(db: DB, cid: number): Set<number> {
  const s = new Set<number>();
  for (const v of db.nominationVotes) if (v.competition_id === cid) s.add(v.candidate_id);
  return s;
}

/** Remove the CALLER's own self-nominations that still have zero votes. Fired by the
 *  page-close beacon so abandoned nominees vanish the moment the nominator leaves.
 *  A nominee anyone has voted for is kept (it's no longer an orphan). Returns count. */
export function sweepOwnOrphans(cid: number, voterId: string): number {
  const db = readDb();
  const voted = votedCandidateIds(db, cid);
  const doomed = db.candidates.filter(
    (c) => c.competition_id === cid && (c.added_by || "") === voterId && c.nominated_at != null && !voted.has(c.id)
  );
  if (!doomed.length) return 0;
  const ids = new Set(doomed.map((c) => c.id));
  db.candidates = db.candidates.filter((c) => !ids.has(c.id));
  db.nominationVotes = db.nominationVotes.filter((v) => !ids.has(v.candidate_id));
  writeDb(db);
  return doomed.length;
}

/** Backstop sweep: remove user-added nominees that are still at zero votes and older
 *  than `graceMs`. Catches the cases the page-close beacon misses (crash, force-kill,
 *  mobile backgrounding). Safe to call often; only writes when something is removed. */
export function sweepOrphanNominations(cid: number, graceMs: number): number {
  const db = readDb();
  const now = Date.now();
  const voted = votedCandidateIds(db, cid);
  const doomed = db.candidates.filter(
    (c) => c.competition_id === cid && !!c.added_by && c.nominated_at != null && now - (c.nominated_at as number) > graceMs && !voted.has(c.id)
  );
  if (!doomed.length) return 0;
  const ids = new Set(doomed.map((c) => c.id));
  db.candidates = db.candidates.filter((c) => !ids.has(c.id));
  db.nominationVotes = db.nominationVotes.filter((v) => !ids.has(v.candidate_id));
  writeDb(db);
  return doomed.length;
}

/** Remove a candidate and all its votes (and any matchups referencing it).
 *  Returns false if the candidate doesn't exist. Only call during nomination. */
/** Edit a candidate's display info (name / cn / en / image / work). Allowed any phase. */
export function editCandidate(cid: number, id: number, f: { name?: string; nameCn?: string; nameEn?: string; image?: string; subjectName?: string }): boolean {
  const db = readDb();
  const c = db.candidates.find((x) => x.id === id && x.competition_id === cid);
  if (!c) return false;
  if (f.name != null && f.name.trim()) c.name = f.name.trim();
  if (f.nameCn != null) c.name_cn = f.nameCn.trim() || null;
  if (f.nameEn != null) c.name_en = f.nameEn.trim() || null;
  if (f.image != null) c.image = f.image.trim() || null;
  if (f.subjectName != null) c.subject_name = f.subjectName.trim() || null;
  writeDb(db);
  return true;
}

/** Merge candidate A(from) into B(to): move A's nomination votes to B (dedup by voter),
 *  then delete A. Nomination phase only (used to collapse duplicate/cross-version entries). */
export function mergeCandidates(cid: number, fromId: number, toId: number): { moved: number } | { error: string } {
  if (fromId === toId) return { error: "不能合并同一个角色。" };
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return { error: "没有比赛。" };
  if (comp.phase !== "nomination") return { error: "仅提名阶段可以合并角色。" };
  const A = db.candidates.find((c) => c.id === fromId && c.competition_id === cid);
  const B = db.candidates.find((c) => c.id === toId && c.competition_id === cid);
  if (!A || !B) return { error: "角色不存在。" };
  const bVoters = new Set(db.nominationVotes.filter((v) => v.competition_id === cid && v.candidate_id === toId).map((v) => v.voter_id));
  let moved = 0;
  for (const v of db.nominationVotes) {
    if (v.competition_id === cid && v.candidate_id === fromId && !bVoters.has(v.voter_id)) {
      v.candidate_id = toId; bVoters.add(v.voter_id); moved++;
    }
  }
  db.nominationVotes = db.nominationVotes.filter((v) => !(v.competition_id === cid && v.candidate_id === fromId));
  db.candidates = db.candidates.filter((c) => !(c.id === fromId && c.competition_id === cid));
  writeDb(db);
  return { moved };
}

export function removeCandidate(cid: number, candidateId: number): boolean {
  const db = readDb();
  if (!db.candidates.some((c) => c.id === candidateId && c.competition_id === cid)) return false;
  db.candidates = db.candidates.filter((c) => c.id !== candidateId);
  db.nominationVotes = db.nominationVotes.filter((v) => v.candidate_id !== candidateId);
  db.approvalVotes = db.approvalVotes.filter((v) => !(v.competition_id === cid && v.candidate_id === candidateId));
  const ids = new Set(db.matchups.filter((m) => m.competition_id === cid && (m.a_id === candidateId || m.b_id === candidateId)).map((m) => m.id));
  db.matchups = db.matchups.filter((m) => !(m.competition_id === cid && (m.a_id === candidateId || m.b_id === candidateId)));
  db.matchVotes = db.matchVotes.filter((v) => !ids.has(v.matchup_id));
  writeDb(db);
  return true;
}

/** Toggle a nomination vote. Returns null if the candidate doesn't exist. */
function toggleNominationOnce(cid: number, candidateId: number, voterId: string, meta?: VoteMeta): { voted: boolean } | { error: string } | null {
  const db = readDb();
  const cand = db.candidates.find((c) => c.id === candidateId && c.competition_id === cid);
  if (!cand) return null;
  const i = db.nominationVotes.findIndex((v) => v.competition_id === cid && v.voter_id === voterId && v.candidate_id === candidateId);
  if (i >= 0) { db.nominationVotes.splice(i, 1); writeDb(db); return { voted: false }; } // 撤回总是允许
  const comp = db.competitions.find((c) => c.id === cid);
  const limit = comp?.nom_user_limit ?? 0;
  if (limit > 0) {
    const cnt = db.nominationVotes.filter((v) => v.competition_id === cid && v.voter_id === voterId).length;
    if (cnt >= limit) return { error: `每人最多提名 ${limit} 个角色，请先撤回一个再提名其他角色。` };
  }
  db.nominationVotes.push({ competition_id: cid, candidate_id: candidateId, voter_id: voterId, created_at: Date.now(), device_bucket: meta?.bucket ?? null, ip: meta?.ip ?? null });
  writeDb(db);
  return { voted: true };
}

/** Read/write the runtime WeChat-gate setting (admin-toggleable). Env WX_VOTE_GATE is only
 *  the initial default when the operator has never toggled it in the admin page. */
export function getWxGate(): boolean {
  const v = (process.env.WX_VOTE_GATE || "").toLowerCase();
  return v === "on" || v === "1" || v === "true";
}

/** Which batch (1-indexed) a group belongs to under approval mode's "N groups per day". */
export function groupBatch(groupNo: number, perDay: number): number {
  return Math.floor(groupNo / Math.max(1, perDay)) + 1;
}
/** approval tally for one competition → Map<candidate_id, approval count>. */
export function approvalTally(db: DB, cid: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const v of db.approvalVotes) if (v.competition_id === cid) m.set(v.candidate_id, (m.get(v.candidate_id) || 0) + 1);
  return m;
}

/** Toggle a group-stage approval vote (approval mode). Enforces ≤2 picks per (voter, group),
 *  ≤1 per candidate, and that the group is in the currently-open batch. */
function castApprovalVoteOnce(cid: number, candidateId: number, voterId: string, meta?: VoteMeta): { picked: boolean; count: number } | { error: string; status: number } {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp || comp.phase !== "group") return { error: "当前不在小组赛阶段。", status: 400 };
  if ((comp.group_mode ?? "approval") !== "approval") return { error: "当前小组赛不是投票晋级模式。", status: 400 };
  const cand = db.candidates.find((c) => c.id === candidateId && c.competition_id === cid);
  if (!cand || cand.group_no == null) return { error: "角色不存在或未分组。", status: 404 };
  const perDay = comp.groups_per_day && comp.groups_per_day > 0 ? comp.groups_per_day : 2;
  const cur = comp.group_matchday ?? 1;
  if (groupBatch(cand.group_no, perDay) !== cur) return { error: "本组当前未开放投票,请等待对应比赛日。", status: 400 };

  const g = cand.group_no;
  const mine = db.approvalVotes.filter((v) => v.competition_id === cid && v.group_no === g && v.voter_id === voterId);
  const existing = mine.find((v) => v.candidate_id === candidateId);
  if (existing) {
    db.approvalVotes = db.approvalVotes.filter((v) => !(v.competition_id === cid && v.group_no === g && v.voter_id === voterId && v.candidate_id === candidateId));
    writeDb(db);
    return { picked: false, count: mine.length - 1 };
  }
  if (mine.length >= 2) return { error: "每组最多投 2 票,请先取消一个再选。", status: 400 };
  db.approvalVotes.push({ competition_id: cid, group_no: g, candidate_id: candidateId, voter_id: voterId, created_at: Date.now(), device_bucket: meta?.bucket ?? null, ip: meta?.ip ?? null });
  writeDb(db);
  return { picked: true, count: mine.length + 1 };
}

/** Cast / change / retract a matchup vote. */
function castMatchVoteOnce(cid: number, matchupId: number, voterId: string, choiceId: number, meta?: VoteMeta): { choice: number | null } | { error: string; status: number } {
  const db = readDb();
  const m = db.matchups.find((x) => x.id === matchupId && x.competition_id === cid);
  if (!m) return { error: "对战不存在。", status: 404 };
  if (m.decided) return { error: "该场已结束，不能再投票。", status: 400 };
  // 小组赛分轮:只有「当前比赛日」的对战可投票
  if (m.stage === "group") {
    const comp = db.competitions.find((c) => c.id === cid);
    const cur = comp?.group_matchday ?? null;
    if (cur != null && (m.matchday ?? cur) !== cur) return { error: "本场对战当前未开放，请等待对应比赛日。", status: 400 };
  }
  if (m.stage === "playoff") {
    const comp = db.competitions.find((c) => c.id === cid);
    if (comp?.phase !== "playoff") return { error: "加赛未开放。", status: 400 };
  }
  if (choiceId !== m.a_id && choiceId !== m.b_id) return { error: "无效的选择。", status: 400 };
  const cur = db.matchVotes.find((v) => v.matchup_id === matchupId && v.voter_id === voterId);
  if (cur && cur.choice_id === choiceId) {
    db.matchVotes = db.matchVotes.filter((v) => !(v.matchup_id === matchupId && v.voter_id === voterId));
    writeDb(db);
    return { choice: null };
  }
  if (cur) cur.choice_id = choiceId;
  else db.matchVotes.push({ matchup_id: matchupId, voter_id: voterId, choice_id: choiceId, created_at: Date.now(), device_bucket: meta?.bucket ?? null, ip: meta?.ip ?? null });
  writeDb(db);
  return { choice: choiceId };
}

// ── comments (per-match discussion) ──
const COMMENT_MAX = 300;
function addCommentOnce(cid: number, matchupId: number, voterId: string, name: string, text: string): { ok: true; comment: Comment } | { error: string } {
  const t = (text || "").trim();
  if (!t) return { error: "评论不能为空。" };
  if (t.length > COMMENT_MAX) return { error: `评论过长(最多 ${COMMENT_MAX} 字)。` };
  const db = readDb();
  if (matchupId) {
    const m = db.matchups.find((x) => x.id === matchupId && x.competition_id === cid);
    if (!m) return { error: "对战不存在。" };
  }
  const nm = (name || "").trim().slice(0, 24);
  const c: Comment = { id: ++db.seq.comment, competition_id: cid, matchup_id: matchupId || 0, voter_id: voterId, name: nm, text: t, created_at: Date.now() };
  db.comments.push(c);
  writeDb(db);
  return { ok: true, comment: c };
}
export function listComments(cid: number, matchupId: number, limit = 100): Comment[] {
  const db = readDb();
  return db.comments
    .filter((c) => c.competition_id === cid && c.matchup_id === (matchupId || 0))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}
export function deleteComment(cid: number, commentId: number): void {
  const db = readDb();
  db.comments = db.comments.filter((c) => !(c.competition_id === cid && c.id === commentId));
  writeDb(db);
}
export function commentCounts(cid: number): Record<number, number> {
  const db = readDb();
  const out: Record<number, number> = {};
  for (const c of db.comments) if (c.competition_id === cid) out[c.matchup_id] = (out[c.matchup_id] || 0) + 1;
  return out;
}

// ── admin observability: audit trail + vote invalidation ──────────────────────
const AUDIT_MAX = 500;

/** Append one entry to the admin audit trail (newest kept; capped at AUDIT_MAX). */
export function logAudit(action: string, summary: string, phase: string | null): void {
  const db = readDb();
  db.auditLog.push({ id: ++db.seq.audit, ts: Date.now(), action, summary, phase: phase ?? null });
  if (db.auditLog.length > AUDIT_MAX) db.auditLog = db.auditLog.slice(-AUDIT_MAX);
  writeDb(db);
}

/** Read the audit trail newest-first (optionally limited). */
export function readAudit(limit = 200): AuditEntry[] {
  const db = readDb();
  return db.auditLog.slice(-limit).reverse();
}

/** Invalidate (delete) every vote in this competition matching a key, across both
 *  nomination and match votes. `by` selects which stored field to match. Returns the
 *  number of votes removed. Match votes are scoped to this competition's matchups.
 *  Note: this does NOT retroactively re-decide already-settled matches — pair it with
 *  "按当前票数重算本轮" if a currently-open round needs recomputing. */
export function invalidateVotes(cid: number, by: "bucket" | "ip" | "voter", key: string): number {
  if (!key) return 0;
  const db = readDb();
  const compMatchIds = new Set(db.matchups.filter((m) => m.competition_id === cid).map((m) => m.id));
  const field = by === "bucket" ? "device_bucket" : by === "ip" ? "ip" : "voter_id";
  let removed = 0;
  const nvBefore = db.nominationVotes.length;
  db.nominationVotes = db.nominationVotes.filter((v) => {
    if (v.competition_id !== cid) return true;
    return (v as any)[field] !== key;
  });
  removed += nvBefore - db.nominationVotes.length;
  const mvBefore = db.matchVotes.length;
  db.matchVotes = db.matchVotes.filter((v) => {
    if (!compMatchIds.has(v.matchup_id)) return true;
    return (v as any)[field] !== key;
  });
  removed += mvBefore - db.matchVotes.length;
  const avBefore = db.approvalVotes.length;
  db.approvalVotes = db.approvalVotes.filter((v) => {
    if (v.competition_id !== cid) return true;
    return (v as any)[field] !== key;
  });
  removed += avBefore - db.approvalVotes.length;
  if (removed) writeDb(db);
  return removed;
}

// ── public vote/comment writers: retry once-per-conflict so a lost write race becomes a
//    successful retry instead of a user-visible error (see retryOnConflict above). ──
export const toggleNomination = (...a: Parameters<typeof toggleNominationOnce>) => retryOnConflict(() => toggleNominationOnce(...a));
export const castApprovalVote = (...a: Parameters<typeof castApprovalVoteOnce>) => retryOnConflict(() => castApprovalVoteOnce(...a));
export const castMatchVote = (...a: Parameters<typeof castMatchVoteOnce>) => retryOnConflict(() => castMatchVoteOnce(...a));
export const addComment = (...a: Parameters<typeof addCommentOnce>) => retryOnConflict(() => addCommentOnce(...a));
