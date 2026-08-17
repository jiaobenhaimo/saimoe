import fs from "fs";
import path from "path";
import { normalizeIp } from "./ip";

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
  third_place?: boolean | null;
  /** item3：黑名单。命中即拒绝进入提名池（tag 取作品标签，作品取名称关键字）。 */
  blocked_tags?: string[] | null; blocked_subjects?: string[] | null;
  /** 维护冻结：freeze_on = 立即停投；freeze_from/to = 预约维护窗口（首页公告 + 窗口内停投）。 */
  freeze_on?: boolean | null; freeze_from?: number | null; freeze_to?: number | null; freeze_note?: string | null; // 是否进行季军战（默认 true）
  // ── timed schedule (epoch ms; null = not scheduled) ──
  nom_ends_at: number | null; group_ends_at: number | null; ko_round_ends_at: number | null;
  auto_size: number | null;
  round_hours: number | null; postpone_days: number | null;
  // ── nomination constraints (null/0 = unlimited) ──
  nom_user_limit: number | null; nom_min_votes: number | null;
  // ── group stage matchdays (round-robin split into rounds) ──
  group_matchday: number | null; group_matchday_count: number | null;
  group_per_round: number | null; group_round_days: number | null; group_round_ends_at: number | null;
  group_day_cap: number | null;   // 每比赛日最多对局数（null=默认 4）
  group_size: number | null;      // 每组人数（null=默认 4；余数补进弱组成 G+1 人组）
  group_mode: "approval" | "rr" | null; // 小组赛玩法：approval=每人组内投2票取前二（默认）；rr=两两对阵循环赛
  groups_per_day: number | null;  // approval 模式：每个比赛日开放几个组投票（默认 2）
  group_started_at: number | null; // 小组赛开赛时间（legacy anchor，仅供旧数据兜底用）
  // 每个比赛日"真实"开始的时间戳（在 startGroups / advanceGroupMatchday 发生的那一刻记录），
  // 作为"日期"列的事实来源——已发生的比赛日永远读这里，不会因为之后调整节奏（setPace）
  // 或提前/延后手动结算而回溯性地改写历史日期。尚未到达的比赛日没有 entry，由 mdDate()
  // 用"最后一个已知比赛日 + 当前节奏"来估算（这部分会随节奏调整而更新，这是正确行为）。
  group_matchday_starts: Record<number, number> | null;
  ko_target: number | null;
  ko_seed_ids: number[] | null; playoff_slots: number | null;
}
export interface Candidate {
  id: number; competition_id: number; bgm_id: string; name: string; name_cn: string | null;
  image: string | null; group_no: number | null; seed: number | null; eliminated: boolean;
  subject_name: string | null; added_by: string | null; name_en: string | null;
  /** 作品名的日文/英文（subject_name 为中文/默认）。 */
  subject_name_ja?: string | null; subject_name_en?: string | null;
  /** 合并进来的旧 bangumi id（item1）：这些 id 都指向本角色，投票/去重都认。 */
  /** 旧版合并（会删除被并入角色）留下的历史 bangumi id。当前合并改为保留角色 + parent_id，
   *  不再写入这里；保留读取逻辑只为让升级前已合并过的旧数据里的 id 仍能解析。 */
  aliases?: string[] | null;
  /** 合并后的「上级」角色 id。子角色不删除、仍可投票、提名池分开显示，
   *  但提名票数汇总到上级；排名/晋级只算上级。null = 自身就是上级。 */
  parent_id?: number | null;
  // epoch ms a *user* self-nominated this (null for admin/subject-imported bulk → never swept)
  nominated_at?: number | null;
}
export interface Matchup {
  id: number; competition_id: number; stage: "group" | "knockout" | "playoff"; round_no: number;
  group_no: number | null; slot: number; a_id: number; b_id: number;
  winner_id: number | null; decided: boolean; matchday?: number | null; bronze?: boolean; // bronze=true： 季军战（半决赛两败者）
}
interface NominationVote { id?: number; competition_id: number; candidate_id: number; voter_id: string; created_at?: number; device_bucket?: string | null; ip?: string | null; }
interface MatchVote { id?: number; matchup_id: number; voter_id: string; choice_id: number; created_at?: number; device_bucket?: string | null; ip?: string | null; }
/** A group-stage approval vote (approval mode): one row per (voter, group, candidate). Max 2 per (voter, group). */
interface ApprovalVote { id?: number; competition_id: number; group_no: number; candidate_id: number; voter_id: string; created_at?: number; device_bucket?: string | null; ip?: string | null; }

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
  seq: { competition: number; candidate: number; matchup: number; comment: number; audit: number; vote: number };
  competitions: Competition[];
  candidates: Candidate[];
  matchups: Matchup[];
  nominationVotes: NominationVote[];
  matchVotes: MatchVote[];
  approvalVotes: ApprovalVote[];
  comments: Comment[];
  auditLog: AuditEntry[];
  /** 票被作废过的身份（用于在其再次投票时给本人提示）。 */
  sanctions?: Sanction[];
  /** 异常投票检测中，被管理员标记为「已复核（误报）」的簇 id（后续报告折叠显示）。 */
  fraudReviewed?: string[];
}
/** 一条「票被作废」的记录。按 voter_id 与设备指纹匹配本人；
 *  故意不按 IP 匹配 —— 宿舍/校园同一出口 IP 下大量无辜用户会被误伤。 */
export interface Sanction { at: number; voterId: string | null; bucket: string | null; count: number; round: string }

/** 当前轮次的标识：删票禁投是「按轮」生效的，所以要能稳定表达「现在是哪一轮」。 */
export function roundKeyOf(c: Competition | undefined): string {
  if (!c) return "none";
  if (c.phase === "nomination") return "nomination";
  if (c.phase === "group") return "group:" + (c.group_matchday ?? 1);
  if (c.phase === "playoff") return "playoff";
  if (c.phase === "knockout") return "knockout:" + (c.ko_round ?? 1);
  return c.phase;
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "saimoe.json");

/** Absolute path of the live data file (used by the backup job). */
export function dataFilePath(): string { return FILE; }

function blank(): DB {
  return { seq: { competition: 0, candidate: 0, matchup: 0, comment: 0, audit: 0, vote: 0 }, competitions: [], candidates: [], matchups: [], nominationVotes: [], matchVotes: [], approvalVotes: [], comments: [], auditLog: [], sanctions: [], fraudReviewed: [] };
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
      vote: Number(o?.seq?.vote) || 0,
    },
    competitions: Array.isArray(o.competitions) ? o.competitions : b.competitions,
    candidates: Array.isArray(o.candidates) ? o.candidates : b.candidates,
    matchups: Array.isArray(o.matchups) ? o.matchups : b.matchups,
    nominationVotes: Array.isArray(o.nominationVotes) ? o.nominationVotes : b.nominationVotes,
    matchVotes: Array.isArray(o.matchVotes) ? o.matchVotes : b.matchVotes,
    approvalVotes: Array.isArray(o.approvalVotes) ? o.approvalVotes : b.approvalVotes,
    comments: Array.isArray(o.comments) ? o.comments : b.comments,
    auditLog: Array.isArray(o.auditLog) ? o.auditLog : b.auditLog,
    sanctions: Array.isArray(o.sanctions) ? o.sanctions : [],
    fraudReviewed: Array.isArray(o.fraudReviewed) ? o.fraudReviewed : [],
  };
}

/** 给还没有 id 的历史投票补号。有了稳定 id，运营才能只作废其中某几票，
 *  而不是把这个设备/IP 的所有票一并清掉。 */
function backfillVoteIds(db: DB): boolean {
  let next = db.seq.vote || 0;
  let touched = false;
  for (const list of [db.nominationVotes, db.matchVotes, db.approvalVotes] as { id?: number }[][]) {
    for (const v of list) if (v.id == null) { v.id = ++next; touched = true; }
  }
  if (touched) db.seq.vote = next;
  return touched;
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
    backfillVoteIds(db); // 历史票补号：下一次写盘时一并持久化
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
  db.competitions.push({ id, title, description: null, short_name: null, title_en: null, title_ja: null, desc_en: null, desc_ja: null, short_en: null, short_ja: null, phase: "nomination", target_size: null, groups_count: null, champion_id: null, ko_round: null, created_at: Date.now(), nom_ends_at: null, group_ends_at: null, ko_round_ends_at: null, auto_size: null, round_hours: null, postpone_days: null, nom_user_limit: null, nom_min_votes: null, group_matchday: null, group_matchday_count: null, group_per_round: null, group_round_days: null, group_round_ends_at: null, group_day_cap: null, group_size: null, group_mode: null, groups_per_day: null, group_started_at: null, group_matchday_starts: null, ko_target: null, ko_seed_ids: null, playoff_slots: null, third_place: null, blocked_tags: [], blocked_subjects: [], freeze_on: null, freeze_from: null, freeze_to: null, freeze_note: null });
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
export function addCandidate(cid: number, bgmId: string, name: string, nameCn: string, image: string, subjectName = "", addedBy = "", nameEn = "", subjectNameJa = "", subjectNameEn = ""): boolean {
  const db = readDb();
  const dup = db.candidates.find((c) => c.competition_id === cid && (c.bgm_id === bgmId || (c.aliases || []).includes(bgmId)));
  if (dup) return false; // 已存在，或曾作为别名被合并进某个角色
  const id = ++db.seq.candidate;
  db.candidates.push({ id, competition_id: cid, bgm_id: bgmId, name, name_cn: nameCn || null, image: image || null, group_no: null, seed: null, eliminated: false, subject_name: subjectName || null, subject_name_ja: subjectNameJa || null, subject_name_en: subjectNameEn || null, added_by: addedBy || null, name_en: nameEn || null, aliases: [], parent_id: null, nominated_at: addedBy ? Date.now() : null });
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
  if (votes > 0) return { error: "已经有人投票，无法移除。" };
  for (const x of db.candidates) if (x.competition_id === cid && x.parent_id === candidateId) x.parent_id = null;
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
  // 被清理的角色可能正是某个合并组的「上级」：先把它的子角色提升为独立角色，
  // 否则会留下指向已删除 id 的 parent_id（子角色仍显示但无法参赛）。
  for (const c of db.candidates) if (c.competition_id === cid && c.parent_id != null && ids.has(c.parent_id)) c.parent_id = null;
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
  // 被清理的角色可能正是某个合并组的「上级」：先把它的子角色提升为独立角色，
  // 否则会留下指向已删除 id 的 parent_id（子角色仍显示但无法参赛）。
  for (const c of db.candidates) if (c.competition_id === cid && c.parent_id != null && ids.has(c.parent_id)) c.parent_id = null;
  db.candidates = db.candidates.filter((c) => !ids.has(c.id));
  db.nominationVotes = db.nominationVotes.filter((v) => !ids.has(v.candidate_id));
  writeDb(db);
  return doomed.length;
}

/** Remove a candidate and all its votes (and any matchups referencing it).
 *  Returns false if the candidate doesn't exist. Only call during nomination. */
/** Edit a candidate's display info (name / cn / en / image / work). Allowed any phase. */
export function editCandidate(cid: number, id: number, f: { name?: string; nameCn?: string; nameEn?: string; image?: string; subjectName?: string; subjectNameJa?: string; subjectNameEn?: string }): boolean {
  const db = readDb();
  const c = db.candidates.find((x) => x.id === id && x.competition_id === cid);
  if (!c) return false;
  if (f.name != null && f.name.trim()) c.name = f.name.trim();
  if (f.nameCn != null) c.name_cn = f.nameCn.trim() || null;
  if (f.nameEn != null) c.name_en = f.nameEn.trim() || null;
  if (f.image != null) c.image = f.image.trim() || null;
  if (f.subjectName != null) c.subject_name = f.subjectName.trim() || null;
  if (f.subjectNameJa != null) c.subject_name_ja = f.subjectNameJa.trim() || null;
  if (f.subjectNameEn != null) c.subject_name_en = f.subjectNameEn.trim() || null;
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
  // 目标取其所在合并组的根，避免链式/环形上级
  let root = B;
  const seen = new Set<number>([root.id]);
  while (root.parent_id != null) {
    const up = db.candidates.find((c) => c.id === root.parent_id && c.competition_id === cid);
    if (!up || seen.has(up.id)) break;
    root = up; seen.add(up.id);
  }
  if (root.id === A.id) return { error: "目标角色已经并入该角色，不能反向合并。" };
  // A 的现有子角色改挂到新的根，保持只有一层
  for (const c of db.candidates) if (c.competition_id === cid && c.parent_id === A.id) c.parent_id = root.id;
  A.parent_id = root.id;
  // 票不搬家、A 也不删除：A 仍可投票并在提名池单独显示，票数在统计时汇总到 root
  const voters = new Set(
    db.nominationVotes.filter((v) => v.competition_id === cid && (v.candidate_id === A.id || v.candidate_id === root.id)).map((v) => v.voter_id));
  writeDb(db);
  return { moved: voters.size };
}

export function removeCandidate(cid: number, candidateId: number): boolean {
  const db = readDb();
  if (!db.candidates.some((c) => c.id === candidateId && c.competition_id === cid)) return false;
  // 被删的若是「上级」，把它的子角色提升为独立角色，否则它们会指向一个已不存在的上级，
  // 变成「池里看得见、却永远不能参赛」的僵尸条目。
  for (const c of db.candidates) if (c.competition_id === cid && c.parent_id === candidateId) c.parent_id = null;
  db.candidates = db.candidates.filter((c) => c.id !== candidateId);
  db.nominationVotes = db.nominationVotes.filter((v) => v.candidate_id !== candidateId);
  db.approvalVotes = db.approvalVotes.filter((v) => !(v.competition_id === cid && v.candidate_id === candidateId));
  const ids = new Set(db.matchups.filter((m) => m.competition_id === cid && (m.a_id === candidateId || m.b_id === candidateId)).map((m) => m.id));
  db.matchups = db.matchups.filter((m) => !(m.competition_id === cid && (m.a_id === candidateId || m.b_id === candidateId)));
  db.matchVotes = db.matchVotes.filter((v) => !ids.has(v.matchup_id));
  writeDb(db);
  return true;
}

/** 维护冻结状态。active = 现在是否停投；upcoming = 预约窗口（未开始时用于首页公告）。 */
export interface FreezeInfo { active: boolean; manual: boolean; from: number | null; to: number | null; note: string; upcoming: boolean; }
/** 纯函数版：调用方已经有 Competition 时用这个，避免再整库读一遍（getState 是热路径）。 */
export function freezeOf(c: Competition | undefined, now = Date.now()): FreezeInfo {
  const from = c?.freeze_from ?? null, to = c?.freeze_to ?? null;
  const manual = !!c?.freeze_on;
  const inWindow = from != null && now >= from && (to == null || now < to);
  return { active: manual || inWindow, manual, from, to, note: c?.freeze_note || "", upcoming: from != null && now < from };
}
export function freezeState(cid: number, now = Date.now()): FreezeInfo {
  const c = readDb().competitions.find((x) => x.id === cid);
  return freezeOf(c, now);
}
/** 设置冻结（admin）。 */
export function setFreeze(cid: number, o: { on?: boolean; from?: number | null; to?: number | null; note?: string }): void {
  const db = readDb();
  const c = db.competitions.find((x) => x.id === cid);
  if (!c) return;
  if (o.on !== undefined) c.freeze_on = !!o.on;
  if (o.from !== undefined) c.freeze_from = o.from ?? null;
  if (o.to !== undefined) c.freeze_to = o.to ?? null;
  if (o.note !== undefined) c.freeze_note = (o.note || "").trim() || null;
  writeDb(db);
}

/** 参赛主体：parent_id 为空，或其上级已不存在（历史悬空数据）的角色。 */
export function topLevel(db: DB, cid: number): Candidate[] {
  const list = db.candidates.filter((c) => c.competition_id === cid);
  const ids = new Set(list.map((c) => c.id));
  return list.filter((c) => c.parent_id == null || !ids.has(c.parent_id));
}

/** 移除预约的维护计划：清掉时间窗与公告文案，但不动「立即停投」开关
 *  （手动停投和预约是两件事：取消计划不应把正在进行的维护也解除）。 */
export function clearFreezePlan(cid: number): void {
  const db = readDb();
  const c = db.competitions.find((x) => x.id === cid);
  if (!c) return;
  c.freeze_from = null;
  c.freeze_to = null;
  c.freeze_note = null;
  writeDb(db);
}

/** 合并组：上级 id → 自身 + 全部子角色 id。 */
export function mergeGroups(db: DB, cid: number): Map<number, number[]> {
  const list = db.candidates.filter((c) => c.competition_id === cid);
  const g = new Map<number, number[]>();
  const ids = new Set(list.map((c) => c.id));
  for (const c of list) if (c.parent_id == null || !ids.has(c.parent_id)) g.set(c.id, [c.id]);
  for (const c of list) if (c.parent_id != null) {
    const arr = g.get(c.parent_id);
    if (arr) arr.push(c.id); else g.set(c.id, [c.id]); // 上级不存在时退化为独立角色
  }
  return g;
}

/** 提名票统计。上级角色按「合并组内不同投票人」计数，所以同一个人把 A 和 B 都投了只算 1 票；
 *  子角色返回它自己的原始票数，仅用于展示（真正参与排名的是上级）。 */
export function nominationTally(db: DB, cid: number): { total: Map<number, number>; own: Map<number, number> } {
  const own = new Map<number, number>();
  const byCand = new Map<number, Set<string>>();
  for (const v of db.nominationVotes) {
    if (v.competition_id !== cid) continue;
    own.set(v.candidate_id, (own.get(v.candidate_id) || 0) + 1);
    if (!byCand.has(v.candidate_id)) byCand.set(v.candidate_id, new Set());
    byCand.get(v.candidate_id)!.add(v.voter_id);
  }
  const total = new Map<number, number>();
  for (const [parent, ids] of mergeGroups(db, cid)) {
    const voters = new Set<string>();
    for (const id of ids) for (const vid of (byCand.get(id) || [])) voters.add(vid);
    total.set(parent, voters.size);
  }
  for (const [id, n] of own) if (!total.has(id)) total.set(id, n);
  return { total, own };
}

/** item3：读黑名单。 */
export function getBlocklist(cid: number): { tags: string[]; subjects: string[] } {
  const c = readDb().competitions.find((x) => x.id === cid);
  return { tags: c?.blocked_tags || [], subjects: c?.blocked_subjects || [] };
}
/** item3：写黑名单（admin）。空行/重复自动清理。 */
export function setBlocklist(cid: number, tags: string[], subjects: string[]): void {
  const db = readDb();
  const c = db.competitions.find((x) => x.id === cid);
  if (!c) return;
  const clean = (a: string[]) => [...new Set((a || []).map((x) => String(x).trim()).filter(Boolean))];
  c.blocked_tags = clean(tags);
  c.blocked_subjects = clean(subjects);
  writeDb(db);
}
/** item3：某个（作品名、标签集合）是否被拉黑。大小写与空格不敏感，按「包含」匹配。
 *  批量场景请先 getBlocklist 拿一次，再用 isBlockedBy —— 否则每个角色都要整库读一遍。 */
export function isBlockedBy(bl: { tags: string[]; subjects: string[] }, subjectName: string, tags: string[] = []): string | null {
  const { tags: bt, subjects: bs } = bl;
  const norm = (x: string) => String(x || "").trim().toLowerCase();
  const sn = norm(subjectName);
  for (const b of bs) if (sn && norm(b) && sn.includes(norm(b))) return `作品「${b}」在黑名单中`;
  const tn = (tags || []).map(norm);
  for (const b of bt) if (norm(b) && tn.some((t) => t === norm(b))) return `标签「${b}」在黑名单中`;
  return null;
}
export function isBlocked(cid: number, subjectName: string, tags: string[] = []): string | null {
  return isBlockedBy(getBlocklist(cid), subjectName, tags);
}

/** item1：把任意标识符（内部 id、bangumi id 如 "c123"、或合并留下的别名）解析成候选角色。
 *  投票接口对外以 bangumi id 为准，合并过的角色用旧 id 也能投到同一个人。 */
export function resolveCandidate(cid: number, ref: string | number): Candidate | null {
  const db = readDb();
  return resolveIn(db, cid, ref);
}
function resolveIn(db: DB, cid: number, ref: string | number): Candidate | null {
  const list = db.candidates.filter((c) => c.competition_id === cid);
  const raw = String(ref ?? "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    const byId = list.find((c) => c.id === n);
    if (byId) return byId;                                  // 内部 id
    const byBgmNum = list.find((c) => c.bgm_id === "c" + n || c.bgm_id === raw
      || (c.aliases || []).includes("c" + n) || (c.aliases || []).includes(raw));
    if (byBgmNum) return byBgmNum;                          // 裸数字当 bangumi id
    return null;
  }
  return list.find((c) => c.bgm_id === raw || (c.aliases || []).includes(raw)) || null;
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
  db.nominationVotes.push({ id: ++db.seq.vote, competition_id: cid, candidate_id: candidateId, voter_id: voterId, created_at: Date.now(), device_bucket: meta?.bucket ?? null, ip: meta?.ip ?? null });
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
  if (groupBatch(cand.group_no, perDay) !== cur) return { error: "本组当前未开放投票，请等待对应比赛日。", status: 400 };

  const g = cand.group_no;
  const mine = db.approvalVotes.filter((v) => v.competition_id === cid && v.group_no === g && v.voter_id === voterId);
  const existing = mine.find((v) => v.candidate_id === candidateId);
  if (existing) {
    db.approvalVotes = db.approvalVotes.filter((v) => !(v.competition_id === cid && v.group_no === g && v.voter_id === voterId && v.candidate_id === candidateId));
    writeDb(db);
    return { picked: false, count: mine.length - 1 };
  }
  if (mine.length >= 2) return { error: "每组最多投 2 票，请先取消一个再选。", status: 400 };
  db.approvalVotes.push({ id: ++db.seq.vote, competition_id: cid, group_no: g, candidate_id: candidateId, voter_id: voterId, created_at: Date.now(), device_bucket: meta?.bucket ?? null, ip: meta?.ip ?? null });
  writeDb(db);
  return { picked: true, count: mine.length + 1 };
}

/** Cast / change / retract a matchup vote. */
function castMatchVoteOnce(cid: number, matchupId: number, voterId: string, choiceId: number, meta?: VoteMeta): { choice: number | null } | { error: string; status: number } {
  const db = readDb();
  const m = db.matchups.find((x) => x.id === matchupId && x.competition_id === cid);
  if (!m) return { error: "对战不存在。", status: 404 };
  if (m.decided) return { error: "该场已结束，不能再投票。", status: 400 };
  // 小组赛分轮：只有「当前比赛日」的对战可投票
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
  else db.matchVotes.push({ id: ++db.seq.vote, matchup_id: matchupId, voter_id: voterId, choice_id: choiceId, created_at: Date.now(), device_bucket: meta?.bucket ?? null, ip: meta?.ip ?? null });
  writeDb(db);
  return { choice: choiceId };
}

// ── comments (per-match discussion) ──
const COMMENT_MAX = 300;
function addCommentOnce(cid: number, matchupId: number, voterId: string, name: string, text: string): { ok: true; comment: Comment } | { error: string } {
  const t = (text || "").trim();
  if (!t) return { error: "评论不能为空。" };
  if (t.length > COMMENT_MAX) return { error: `评论过长（最多 ${COMMENT_MAX} 字）。` };
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

/** 按 by 匹配单张票。`ip64` 表示按 /64 归一化前缀匹配（同一条宽带 IPv6 后缀频繁变化，
 *  /64 前缀才是稳定身份）。 */
function voteMatcher(by: "bucket" | "ip" | "voter" | "ip64", key: string): (v: { device_bucket?: string | null; ip?: string | null; voter_id?: string }) => boolean {
  switch (by) {
    case "bucket": return (v) => v.device_bucket === key;
    case "ip": return (v) => v.ip === key;
    case "voter": return (v) => v.voter_id === key;
    case "ip64": return (v) => normalizeIp(v.ip) === key;
  }
}

/** Invalidate (delete) every vote in this competition matching a key, across both
 *  nomination and match votes. `by` selects which stored field to match. Returns the
 *  number of votes removed. Match votes are scoped to this competition's matchups.
 *  Note: this does NOT retroactively re-decide already-settled matches — pair it with
 *  "按当前票数重算本轮" if a currently-open round needs recomputing. */
export function invalidateVotes(cid: number, by: "bucket" | "ip" | "voter" | "ip64", key: string): number {
  if (!key) return 0;
  const db = readDb();
  const compMatchIds = new Set(db.matchups.filter((m) => m.competition_id === cid).map((m) => m.id));
  // 只收本届的票：matchVotes 没有 competition_id，必须用本届的对局 id 过滤，
  // 否则会把其它届的同一身份也记成本届的受罚记录。
  const match = voteMatcher(by, key);
  const victims = [
    ...db.nominationVotes.filter((v) => v.competition_id === cid),
    ...db.approvalVotes.filter((v) => v.competition_id === cid),
    ...db.matchVotes.filter((v) => compMatchIds.has(v.matchup_id)),
  ].filter(match);
  let removed = 0;
  const nvBefore = db.nominationVotes.length;
  db.nominationVotes = db.nominationVotes.filter((v) => !(v.competition_id === cid && match(v)));
  removed += nvBefore - db.nominationVotes.length;
  const mvBefore = db.matchVotes.length;
  db.matchVotes = db.matchVotes.filter((v) => !(compMatchIds.has(v.matchup_id) && match(v)));
  removed += mvBefore - db.matchVotes.length;
  const avBefore = db.approvalVotes.length;
  db.approvalVotes = db.approvalVotes.filter((v) => !(v.competition_id === cid && match(v)));
  removed += avBefore - db.approvalVotes.length;
  if (removed) { recordSanctions(db, cid, victims as any); writeDb(db); }
  return removed;
}

// ── public vote/comment writers: retry once-per-conflict so a lost write race becomes a
//    successful retry instead of a user-visible error (see retryOnConflict above). ──
export const toggleNomination = (...a: Parameters<typeof toggleNominationOnce>) => retryOnConflict(() => toggleNominationOnce(...a));
export const castApprovalVote = (...a: Parameters<typeof castApprovalVoteOnce>) => retryOnConflict(() => castApprovalVoteOnce(...a));
export const castMatchVote = (...a: Parameters<typeof castMatchVoteOnce>) => retryOnConflict(() => castMatchVoteOnce(...a));
export const addComment = (...a: Parameters<typeof addCommentOnce>) => retryOnConflict(() => addCommentOnce(...a));

/** 可疑票溯源：列出某个身份（设备指纹 / IP(/64) / 投票人）在本届投过的每一票，
 *  含投给了谁、什么阶段、什么时候。给运营用来逐票判断，而不是只能整批清掉。 */
export function listVotesBy(cid: number, by: "bucket" | "ip" | "voter" | "ip64", key: string): {
  id: number; kind: "nomination" | "approval" | "match"; at: number | null;
  target: string; detail: string; voterId: string; bucket: string | null; ip: string | null;
}[] {
  if (!key) return [];
  const db = readDb();
  const match = voteMatcher(by, key);
  const nameOf = (id: number) => {
    const c = db.candidates.find((x) => x.id === id);
    return c ? (c.name_cn || c.name) : `#${id}`;
  };
  const compMatch = new Map(db.matchups.filter((m) => m.competition_id === cid).map((m) => [m.id, m]));
  const rows: ReturnType<typeof listVotesBy> = [];

  for (const v of db.nominationVotes) {
    if (v.competition_id !== cid || !match(v)) continue;
    rows.push({ id: v.id ?? 0, kind: "nomination", at: v.created_at ?? null, target: nameOf(v.candidate_id),
      detail: "提名投票", voterId: v.voter_id, bucket: v.device_bucket ?? null, ip: v.ip ?? null });
  }
  for (const v of db.approvalVotes) {
    if (v.competition_id !== cid || !match(v)) continue;
    rows.push({ id: v.id ?? 0, kind: "approval", at: v.created_at ?? null, target: nameOf(v.candidate_id),
      detail: `小组赛 ${groupLetter(v.group_no)} 组`, voterId: v.voter_id, bucket: v.device_bucket ?? null, ip: v.ip ?? null });
  }
  for (const v of db.matchVotes) {
    const m = compMatch.get(v.matchup_id);
    if (!m || !match(v)) continue;
    const other = m.a_id === v.choice_id ? m.b_id : m.a_id;
    const stage = m.stage === "group" ? `小组赛 ${groupLetter(m.group_no ?? 0)} 组`
      : m.stage === "playoff" ? "加赛" : `淘汰赛第 ${m.round_no} 轮`;
    rows.push({ id: v.id ?? 0, kind: "match", at: v.created_at ?? null, target: nameOf(v.choice_id),
      detail: `${stage}：对手 ${nameOf(other)}`, voterId: v.voter_id, bucket: v.device_bucket ?? null, ip: v.ip ?? null });
  }
  // 新的在前，方便看「最近这一串是不是连着刷的」
  rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return rows;
}
function groupLetter(n: number): string {
  let s = ""; let x = Math.max(0, Math.floor(n));
  do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
  return s;
}

/** 精确作废：只删掉指定 id 的那几票。返回实际删除数。 */
export function invalidateVoteIds(cid: number, ids: number[]): number {
  const want = new Set(ids.filter((n) => Number.isFinite(n) && n > 0));
  if (!want.size) return 0;
  const db = readDb();
  const compMatchIds = new Set(db.matchups.filter((m) => m.competition_id === cid).map((m) => m.id));
  let removed = 0;
  const victims: { voter_id: string; device_bucket?: string | null }[] = [];
  const keepNom = db.nominationVotes.filter((v) => {
    const hit = v.competition_id === cid && v.id != null && want.has(v.id);
    if (hit) { removed++; victims.push(v); }
    return !hit;
  });
  const keepApp = db.approvalVotes.filter((v) => {
    const hit = v.competition_id === cid && v.id != null && want.has(v.id);
    if (hit) { removed++; victims.push(v); }
    return !hit;
  });
  const keepMatch = db.matchVotes.filter((v) => {
    const hit = compMatchIds.has(v.matchup_id) && v.id != null && want.has(v.id);
    if (hit) { removed++; victims.push(v); }
    return !hit;
  });
  if (removed) {
    db.nominationVotes = keepNom; db.approvalVotes = keepApp; db.matchVotes = keepMatch;
    recordSanctions(db, cid, victims); // 记下这些身份：本人会看到提示，且本轮不得再投
    writeDb(db);
  }
  return removed;
}

/** 把这些票所属的身份记进 sanctions，供其下次投票时提示本人。 */
function recordSanctions(db: DB, cid: number, victims: { voter_id: string; device_bucket?: string | null }[]): void {
  if (!victims.length) return;
  const round = roundKeyOf(db.competitions.find((c) => c.id === cid));
  const byKey = new Map<string, { voterId: string | null; bucket: string | null; count: number }>();
  for (const v of victims) {
    const k = v.voter_id + "|" + (v.device_bucket || "");
    const cur = byKey.get(k) || { voterId: v.voter_id || null, bucket: v.device_bucket || null, count: 0 };
    cur.count++; byKey.set(k, cur);
  }
  db.sanctions = [...(db.sanctions || []), ...[...byKey.values()].map((x) => ({ at: Date.now(), round, ...x }))].slice(-500);
}

/** 这个身份是否被作废过票（本人提示用）。按 voter_id 或设备指纹匹配，不按 IP。 */
export function voterSanction(who: { voterId?: string | null; bucket?: string | null }, round?: string):
  { count: number; at: number; rounds: string[]; blockedThisRound: boolean } | null {
  const list = readDb().sanctions || [];
  if (!list.length) return null;
  let count = 0, at = 0; const rounds = new Set<string>(); let blocked = false;
  for (const s of list) {
    const hit = (who.voterId && s.voterId === who.voterId) || (who.bucket && s.bucket && s.bucket === who.bucket);
    if (!hit) continue;
    count += s.count; at = Math.max(at, s.at); rounds.add(s.round || "");
    if (round && s.round === round) blocked = true;
  }
  return count > 0 ? { count, at, rounds: [...rounds], blockedThisRound: blocked } : null;
}

/** 智能删票的方案（只计算、不执行；执行仍走 invalidateVoteIds，以便记录受罚身份）。
 *
 *  规则（按运营要求）：
 *   a) 这个 IP/设备下，**每个角色只保留 1 票**（保留最早那张，其余删掉）——刷票的形态就是
 *      同一角色被同一台设备投多次；
 *   b) **每个身份至少被删 1 票**——若某身份在 (a) 之后一票未删（它投的角色恰好都只投了一次），
 *      则再删掉它最新的一票，让"每个参与刷票的身份都付出代价"。
 *  同时给出影响预估：哪些角色会因此掉到 0 票（配合 nom_min_votes 会直接失去资格）。 */
export function planSmartInvalidate(cid: number, by: "bucket" | "ip" | "voter" | "ip64", key: string): {
  ids: number[];
  perTarget: { target: string; had: number; deleted: number }[];
  perIdentity: { voterId: string; had: number; deleted: number }[];
  zeroed: { target: string; totalBefore: number }[];
} {
  const empty = { ids: [], perTarget: [], perIdentity: [], zeroed: [] };
  if (!key) return empty;
  const db = readDb();
  const rows = listVotesBy(cid, by, key);
  if (!rows.length) return empty;

  // (a) 每个角色留最早一张
  const byTarget = new Map<string, typeof rows>();
  for (const r of rows) { if (!byTarget.has(r.target)) byTarget.set(r.target, []); byTarget.get(r.target)!.push(r); }
  const kill = new Set<number>();
  const perTarget: { target: string; had: number; deleted: number }[] = [];
  for (const [target, list] of byTarget) {
    const sorted = [...list].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const doomed = sorted.slice(1); // 保留最早
    doomed.forEach((r) => kill.add(r.id));
    perTarget.push({ target, had: list.length, deleted: doomed.length });
  }
  // (b) 每个身份至少删 1 票
  const byIdent = new Map<string, typeof rows>();
  for (const r of rows) { if (!byIdent.has(r.voterId)) byIdent.set(r.voterId, []); byIdent.get(r.voterId)!.push(r); }
  const perIdentity: { voterId: string; had: number; deleted: number }[] = [];
  for (const [voterId, list] of byIdent) {
    let deleted = list.filter((r) => kill.has(r.id)).length;
    if (deleted === 0) {
      const latest = [...list].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
      if (latest) { kill.add(latest.id); deleted = 1; }
    }
    perIdentity.push({ voterId, had: list.length, deleted });
  }
  // 影响预估：删完之后总票数归零的角色
  const nameOf = (id: number) => { const c = db.candidates.find((x) => x.id === id); return c ? (c.name_cn || c.name) : `#${id}`; };
  const totalByName = new Map<string, number>();
  for (const v of db.nominationVotes) if (v.competition_id === cid) {
    const n = nameOf(v.candidate_id); totalByName.set(n, (totalByName.get(n) || 0) + 1);
  }
  for (const v of db.approvalVotes) if (v.competition_id === cid) {
    const n = nameOf(v.candidate_id); totalByName.set(n, (totalByName.get(n) || 0) + 1);
  }
  const killedByName = new Map<string, number>();
  for (const r of rows) if (kill.has(r.id)) killedByName.set(r.target, (killedByName.get(r.target) || 0) + 1);
  const zeroed: { target: string; totalBefore: number }[] = [];
  for (const [name, k] of killedByName) {
    const before = totalByName.get(name) || 0;
    if (before > 0 && before - k <= 0) zeroed.push({ target: name, totalBefore: before });
  }
  perTarget.sort((a, b) => b.deleted - a.deleted || b.had - a.had);
  perIdentity.sort((a, b) => b.deleted - a.deleted);
  return { ids: [...kill], perTarget, perIdentity, zeroed };
}
