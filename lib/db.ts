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
 * Caveats (inherent to local storage): the container filesystem on most PaaS
 * (incl. CloudBase Run) is EPHEMERAL, so data resets on redeploy/restart unless
 * DATA_DIR points at a mounted persistent volume; and multiple instances each
 * keep their own file, so run a SINGLE instance.
 */

export type Phase = "nomination" | "group" | "knockout" | "finished";

export interface Competition {
  id: number; title: string; description: string | null; phase: Phase;
  target_size: number | null; groups_count: number | null; advance_per_group: number | null;
  champion_id: number | null; ko_round: number | null; created_at: number;
  // ── timed schedule (epoch ms; null = not scheduled) ──
  nom_ends_at: number | null; group_ends_at: number | null; ko_round_ends_at: number | null;
  auto_size: number | null; auto_groups: number | null; auto_advance: number | null;
  group_hours: number | null; round_hours: number | null; postpone_days: number | null;
}
export interface Candidate {
  id: number; competition_id: number; bgm_id: string; name: string; name_cn: string | null;
  image: string | null; group_no: number | null; seed: number | null; eliminated: boolean;
}
export interface Matchup {
  id: number; competition_id: number; stage: "group" | "knockout"; round_no: number;
  group_no: number | null; slot: number; a_id: number; b_id: number;
  winner_id: number | null; decided: boolean;
}
interface NominationVote { competition_id: number; candidate_id: number; voter_id: string; }
interface MatchVote { matchup_id: number; voter_id: string; choice_id: number; }

export interface DB {
  seq: { competition: number; candidate: number; matchup: number };
  competitions: Competition[];
  candidates: Candidate[];
  matchups: Matchup[];
  nominationVotes: NominationVote[];
  matchVotes: MatchVote[];
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "saimoe.json");

function blank(): DB {
  return { seq: { competition: 0, candidate: 0, matchup: 0 }, competitions: [], candidates: [], matchups: [], nominationVotes: [], matchVotes: [] };
}
function normalize(o: any): DB {
  if (!o || typeof o !== "object") return blank();
  const b = blank();
  return {
    seq: {
      competition: Number(o?.seq?.competition) || 0,
      candidate: Number(o?.seq?.candidate) || 0,
      matchup: Number(o?.seq?.matchup) || 0,
    },
    competitions: Array.isArray(o.competitions) ? o.competitions : b.competitions,
    candidates: Array.isArray(o.candidates) ? o.candidates : b.candidates,
    matchups: Array.isArray(o.matchups) ? o.matchups : b.matchups,
    nominationVotes: Array.isArray(o.nominationVotes) ? o.nominationVotes : b.nominationVotes,
    matchVotes: Array.isArray(o.matchVotes) ? o.matchVotes : b.matchVotes,
  };
}

/** Read the whole store from disk (or a blank store if the file is absent). */
export function readDb(): DB {
  try { return normalize(JSON.parse(fs.readFileSync(FILE, "utf8"))); }
  catch { return blank(); }
}
/** Persist the store atomically (write temp file, then rename). */
export function writeDb(db: DB): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
/** Kept for API compatibility with the old DB layer; just ensures the dir exists. */
export function ensureSchema(): void {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

// ── route-level operations (each is an atomic read-modify-write) ──

export function createCompetition(title: string): number {
  const db = readDb();
  const id = ++db.seq.competition;
  db.competitions.push({ id, title, description: null, phase: "nomination", target_size: null, groups_count: null, advance_per_group: null, champion_id: null, ko_round: null, created_at: Date.now(), nom_ends_at: null, group_ends_at: null, ko_round_ends_at: null, auto_size: null, auto_groups: null, auto_advance: null, group_hours: null, round_hours: null, postpone_days: null });
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
  writeDb(db);
}

/** Insert a candidate; returns false if (competition, bgm_id) already exists. */
export function addCandidate(cid: number, bgmId: string, name: string, nameCn: string, image: string): boolean {
  const db = readDb();
  if (db.candidates.some((c) => c.competition_id === cid && c.bgm_id === bgmId)) return false;
  const id = ++db.seq.candidate;
  db.candidates.push({ id, competition_id: cid, bgm_id: bgmId, name, name_cn: nameCn || null, image: image || null, group_no: null, seed: null, eliminated: false });
  writeDb(db);
  return true;
}

/** Toggle a nomination vote. Returns null if the candidate doesn't exist. */
export function toggleNomination(cid: number, candidateId: number, voterId: string): { voted: boolean } | null {
  const db = readDb();
  const cand = db.candidates.find((c) => c.id === candidateId && c.competition_id === cid);
  if (!cand) return null;
  const i = db.nominationVotes.findIndex((v) => v.competition_id === cid && v.voter_id === voterId && v.candidate_id === candidateId);
  if (i >= 0) { db.nominationVotes.splice(i, 1); writeDb(db); return { voted: false }; }
  db.nominationVotes.push({ competition_id: cid, candidate_id: candidateId, voter_id: voterId });
  writeDb(db);
  return { voted: true };
}

/** Cast / change / retract a matchup vote. */
export function castMatchVote(cid: number, matchupId: number, voterId: string, choiceId: number): { choice: number | null } | { error: string; status: number } {
  const db = readDb();
  const m = db.matchups.find((x) => x.id === matchupId && x.competition_id === cid);
  if (!m) return { error: "对战不存在。", status: 404 };
  if (m.decided) return { error: "该场已结束，不能再投票。", status: 400 };
  if (choiceId !== m.a_id && choiceId !== m.b_id) return { error: "无效的选择。", status: 400 };
  const cur = db.matchVotes.find((v) => v.matchup_id === matchupId && v.voter_id === voterId);
  if (cur && cur.choice_id === choiceId) {
    db.matchVotes = db.matchVotes.filter((v) => !(v.matchup_id === matchupId && v.voter_id === voterId));
    writeDb(db);
    return { choice: null };
  }
  if (cur) cur.choice_id = choiceId;
  else db.matchVotes.push({ matchup_id: matchupId, voter_id: voterId, choice_id: choiceId });
  writeDb(db);
  return { choice: choiceId };
}
