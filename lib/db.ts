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
  target_size: number | null; groups_count: number | null; advance_per_group: number | null;
  champion_id: number | null; ko_round: number | null; created_at: number;
  // ── timed schedule (epoch ms; null = not scheduled) ──
  nom_ends_at: number | null; group_ends_at: number | null; ko_round_ends_at: number | null;
  auto_size: number | null; auto_groups: number | null; auto_advance: number | null;
  group_hours: number | null; round_hours: number | null; postpone_days: number | null;
  // ── nomination constraints (null/0 = unlimited) ──
  nom_user_limit: number | null; nom_min_votes: number | null;
  // ── group stage matchdays (round-robin split into rounds) ──
  group_matchday: number | null; group_matchday_count: number | null;
  group_per_round: number | null; group_round_days: number | null; group_round_ends_at: number | null;
  group_day_cap: number | null;   // 每比赛日最多对局数(null=默认 4)
  group_started_at: number | null; // 小组赛开赛时间——各比赛日的固定日期以此为锚点
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
  winner_id: number | null; decided: boolean; matchday?: number | null;
}
interface NominationVote { competition_id: number; candidate_id: number; voter_id: string; created_at?: number; device_bucket?: string | null; ip?: string | null; }
interface MatchVote { matchup_id: number; voter_id: string; choice_id: number; created_at?: number; device_bucket?: string | null; ip?: string | null; }

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
  comments: Comment[];
  auditLog: AuditEntry[];
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "saimoe.json");

/** Absolute path of the live data file (used by the backup job). */
export function dataFilePath(): string { return FILE; }

function blank(): DB {
  return { seq: { competition: 0, candidate: 0, matchup: 0, comment: 0, audit: 0 }, competitions: [], candidates: [], matchups: [], nominationVotes: [], matchVotes: [], comments: [], auditLog: [] };
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
    comments: Array.isArray(o.comments) ? o.comments : b.comments,
    auditLog: Array.isArray(o.auditLog) ? o.auditLog : b.auditLog,
  };
}

/** Read the whole store from disk (or a blank store if the file is absent).
 *  Cached by file mtime so repeated reads in one process skip the disk read;
 *  always returns a deep clone, so callers can mutate freely before writeDb().
 *  A corrupt/partial file is quarantined (renamed aside) and logged, instead of
 *  silently starting blank and then overwriting the damaged data. */
let cache: { mtimeMs: number; db: DB } | null = null;
export function readDb(): DB {
  try {
    const st = fs.statSync(FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) return structuredClone(cache.db);
    const db = normalize(JSON.parse(fs.readFileSync(FILE, "utf8")));
    cache = { mtimeMs: st.mtimeMs, db };
    return structuredClone(db);
  } catch (e) {
    try {
      if (fs.existsSync(FILE)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const quarantined = FILE + ".corrupt-" + ts;
        fs.renameSync(FILE, quarantined);
        console.error("saimoe: data file unreadable, moved to " + quarantined, e);
      }
    } catch {}
    return blank();
  }
}
/** Persist the store atomically (write temp file, then rename), and refresh the cache. */
export function writeDb(db: DB): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
  try { cache = { mtimeMs: fs.statSync(FILE).mtimeMs, db: structuredClone(db) }; }
  catch { cache = null; }
}
/** Kept for API compatibility with the old DB layer; just ensures the dir exists. */
export function ensureSchema(): void {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

// ── route-level operations (each is an atomic read-modify-write) ──

export function createCompetition(title: string): number {
  const db = readDb();
  const id = ++db.seq.competition;
  db.competitions.push({ id, title, description: null, short_name: null, phase: "nomination", target_size: null, groups_count: null, advance_per_group: null, champion_id: null, ko_round: null, created_at: Date.now(), nom_ends_at: null, group_ends_at: null, ko_round_ends_at: null, auto_size: null, auto_groups: null, auto_advance: null, group_hours: null, round_hours: null, postpone_days: null, nom_user_limit: null, nom_min_votes: null, group_matchday: null, group_matchday_count: null, group_per_round: null, group_round_days: null, group_round_ends_at: null, group_day_cap: null, group_started_at: null, ko_target: null, ko_seed_ids: null, playoff_slots: null });
  writeDb(db);
  return id;
}

export function deleteCompetition(cid: number): void {
  const db = readDb();
  const candIds = new Set(db.candidates.filter((c) => c.competition_id === cid).map((c) => c.id));
  const matchIds = new Set(db.matchups.filter((m) => m.competition_id === cid).map((m) => m.id));
  db.competitions = db.competitions.filter((c) => c.id !== cid);
  db.candidates = db.candidates.filter((c) => c.competition_id !== cid);
  db.matchups = db.matchups.filter((m) => m.competition_id !== cid);
  db.nominationVotes = db.nominationVotes.filter((v) => v.competition_id !== cid && !candIds.has(v.candidate_id));
  db.matchVotes = db.matchVotes.filter((v) => !matchIds.has(v.matchup_id));
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
export function removeCandidate(cid: number, candidateId: number): boolean {
  const db = readDb();
  if (!db.candidates.some((c) => c.id === candidateId && c.competition_id === cid)) return false;
  db.candidates = db.candidates.filter((c) => c.id !== candidateId);
  db.nominationVotes = db.nominationVotes.filter((v) => v.candidate_id !== candidateId);
  const ids = new Set(db.matchups.filter((m) => m.competition_id === cid && (m.a_id === candidateId || m.b_id === candidateId)).map((m) => m.id));
  db.matchups = db.matchups.filter((m) => !(m.competition_id === cid && (m.a_id === candidateId || m.b_id === candidateId)));
  db.matchVotes = db.matchVotes.filter((v) => !ids.has(v.matchup_id));
  writeDb(db);
  return true;
}

/** Toggle a nomination vote. Returns null if the candidate doesn't exist. */
export function toggleNomination(cid: number, candidateId: number, voterId: string, meta?: VoteMeta): { voted: boolean } | { error: string } | null {
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

/** Cast / change / retract a matchup vote. */
export function castMatchVote(cid: number, matchupId: number, voterId: string, choiceId: number, meta?: VoteMeta): { choice: number | null } | { error: string; status: number } {
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
export function addComment(cid: number, matchupId: number, voterId: string, name: string, text: string): { ok: true; comment: Comment } | { error: string } {
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
  if (removed) writeDb(db);
  return removed;
}
