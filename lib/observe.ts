import { readDb } from "./db";

// ── tunable detection thresholds (env-overridable) ────────────────────────────
function envNum(key: string, dflt: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
const DEVICE_MIN = envNum("SAIMOE_OBS_DEVICE_MIN", 3);   // distinct identities sharing one device fingerprint
const IP_MIN = envNum("SAIMOE_OBS_IP_MIN", 4);           // distinct identities sharing one IP (higher: NAT)
const BURST_WINDOW_MS = envNum("SAIMOE_OBS_BURST_WINDOW_MS", 10_000);
const BURST_MIN = envNum("SAIMOE_OBS_BURST_MIN", 8);     // votes by one identity within the window
const COVERAGE_PCT = Math.min(1, envNum("SAIMOE_OBS_COVERAGE_PCT", 0.9)); // share of all matches one identity voted on
const COVERAGE_MIN_MATCHES = 10;                          // don't flag coverage until the field is big enough

export type FlagType = "device" | "ip" | "burst" | "coverage";
export interface Flag {
  type: FlagType;
  by: "bucket" | "ip" | "voter"; // which stored field an "invalidate" action would match
  key: string;                   // exact value to match when invalidating
  keyShort: string;              // display-friendly
  identities?: number;
  votes: number;
  detail: string;                // human-readable explanation (zh)
}

function short(s: string, n = 10): string {
  if (!s) return "—";
  return s.length <= n + 2 ? s : s.slice(0, n) + "…";
}

/** Scan this competition's votes for suspicious patterns. Read-only; returns flags
 *  an operator can review (and optionally act on via invalidateVotes). */
export function detectAnomalies(cid: number): {
  flags: Flag[];
  thresholds: Record<string, number>;
  totals: { votes: number; matches: number; withMeta: number };
} {
  const db = readDb();
  const compMatchIds = new Set(db.matchups.filter((m) => m.competition_id === cid).map((m) => m.id));

  interface Ev { voter: string; bucket: string | null; ip: string | null; ts: number | null; matchId: number | null; }
  const evs: Ev[] = [];
  for (const v of db.matchVotes) if (compMatchIds.has(v.matchup_id))
    evs.push({ voter: v.voter_id, bucket: v.device_bucket ?? null, ip: v.ip ?? null, ts: v.created_at ?? null, matchId: v.matchup_id });
  for (const v of db.nominationVotes) if (v.competition_id === cid)
    evs.push({ voter: v.voter_id, bucket: v.device_bucket ?? null, ip: v.ip ?? null, ts: v.created_at ?? null, matchId: null });
  // approval-mode group votes (no matchup_id): fold in so device/IP/burst detection covers them too
  for (const v of db.approvalVotes) if (v.competition_id === cid)
    evs.push({ voter: v.voter_id, bucket: v.device_bucket ?? null, ip: v.ip ?? null, ts: v.created_at ?? null, matchId: null });

  const flags: Flag[] = [];
  const withMeta = evs.filter((e) => e.bucket || e.ip || e.ts != null).length;

  // 1) one device fingerprint → many identities
  const byBucket = new Map<string, { voters: Set<string>; votes: number }>();
  evs.forEach((e) => {
    if (!e.bucket) return;
    const g = byBucket.get(e.bucket) || { voters: new Set<string>(), votes: 0 };
    g.voters.add(e.voter); g.votes++; byBucket.set(e.bucket, g);
  });
  byBucket.forEach((g, k) => {
    if (g.voters.size >= DEVICE_MIN)
      flags.push({ type: "device", by: "bucket", key: k, keyShort: short(k), identities: g.voters.size, votes: g.votes,
        detail: `同一设备指纹关联 ${g.voters.size} 个投票身份、共 ${g.votes} 票(疑似一台设备多浏览器/无痕刷票)` });
  });

  // 2) one IP → many identities (higher bar: NAT legitimately shares an IP)
  const byIp = new Map<string, { voters: Set<string>; votes: number }>();
  evs.forEach((e) => {
    if (!e.ip || e.ip === "unknown") return;
    const g = byIp.get(e.ip) || { voters: new Set<string>(), votes: 0 };
    g.voters.add(e.voter); g.votes++; byIp.set(e.ip, g);
  });
  byIp.forEach((g, k) => {
    if (g.voters.size >= IP_MIN)
      flags.push({ type: "ip", by: "ip", key: k, keyShort: k, identities: g.voters.size, votes: g.votes,
        detail: `同一 IP 关联 ${g.voters.size} 个身份、共 ${g.votes} 票(注意:NAT/校园网下多人可能共用 IP)` });
  });

  // 3) burst: one identity casting many votes inside a short window
  const byVoterTs = new Map<string, number[]>();
  evs.forEach((e) => {
    if (e.ts == null) return;
    const arr = byVoterTs.get(e.voter) || [];
    arr.push(e.ts); byVoterTs.set(e.voter, arr);
  });
  byVoterTs.forEach((tsArr, voter) => {
    if (tsArr.length < BURST_MIN) return;
    tsArr.sort((a, b) => a - b);
    let best = 1, lo = 0;
    for (let hi = 0; hi < tsArr.length; hi++) {
      while (tsArr[hi] - tsArr[lo] > BURST_WINDOW_MS) lo++;
      best = Math.max(best, hi - lo + 1);
    }
    if (best >= BURST_MIN)
      flags.push({ type: "burst", by: "voter", key: voter, keyShort: short(voter), votes: tsArr.length,
        detail: `该身份在 ${Math.round(BURST_WINDOW_MS / 1000)} 秒内投出 ${best} 票(共 ${tsArr.length} 票),疑似脚本` });
  });

  // 4) coverage: one identity voted on nearly every match
  const totalMatches = compMatchIds.size;
  if (totalMatches >= COVERAGE_MIN_MATCHES) {
    const byVoterMatches = new Map<string, Set<number>>();
    for (const v of db.matchVotes) if (compMatchIds.has(v.matchup_id)) {
      const s = byVoterMatches.get(v.voter_id) || new Set<number>();
      s.add(v.matchup_id); byVoterMatches.set(v.voter_id, s);
    }
    byVoterMatches.forEach((s, voter) => {
      const pct = s.size / totalMatches;
      if (pct >= COVERAGE_PCT)
        flags.push({ type: "coverage", by: "voter", key: voter, keyShort: short(voter), votes: s.size,
          detail: `该身份投了 ${s.size}/${totalMatches} 场(${Math.round(pct * 100)}%),覆盖率异常高` });
    });
  }

  flags.sort((a, b) => (b.identities ?? 0) - (a.identities ?? 0) || b.votes - a.votes);
  return {
    flags: flags.slice(0, 100),
    thresholds: { DEVICE_MIN, IP_MIN, BURST_WINDOW_MS, BURST_MIN, COVERAGE_PCT },
    totals: { votes: evs.length, matches: totalMatches, withMeta },
  };
}

// ── schedule timeline projection ──────────────────────────────────────────────
export interface TimelineItem { label: string; at: number | null; note: string; done?: boolean; }

const DAY = 86_400_000, HOUR = 3_600_000;
function koLabel(contenders: number): string {
  if (contenders <= 2) return "决赛";
  if (contenders === 4) return "半决赛";
  if (contenders === 8) return "四分之一决赛";
  return `${contenders} 强`;
}

/** Project the remaining phase transitions from the schedule fields. Times are
 *  estimates that assume the current cadence holds; `at=null` means "manual / not
 *  auto-scheduled". Useful as a preview, not a guarantee. */
export function projectTimeline(cid: number): TimelineItem[] {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return [];
  const items: TimelineItem[] = [];
  const koTarget = comp.ko_target ?? 0;
  const koRoundsTotal = koTarget ? Math.max(1, Math.round(Math.log2(koTarget))) : 0;

  if (comp.phase === "nomination") {
    items.push({ label: "提名截止", at: comp.nom_ends_at ?? null, note: comp.nom_ends_at ? "" : "未定时(需手动开赛)" });
    items.push({ label: "小组赛开始", at: null, note: "提名截止后;比赛日数在开赛时确定" });
    return items;
  }

  let cursor: number | null = null;

  if (comp.phase === "group") {
    const cur = comp.group_matchday ?? 1, cnt = comp.group_matchday_count ?? 1;
    const pace = comp.group_round_days ?? 0;
    cursor = comp.group_round_ends_at ?? null;
    items.push({ label: `小组赛 第 ${cur}/${cnt} 比赛日 结算`, at: cursor, note: cursor ? "" : "手动结算" });
    for (let d = cur + 1; d <= cnt; d++) {
      cursor = cursor && pace > 0 ? cursor + pace * DAY : null;
      items.push({ label: `小组赛 第 ${d}/${cnt} 比赛日 结算`, at: cursor, note: cursor ? "" : "需设定每比赛日天数" });
    }
  } else if (comp.phase === "playoff") {
    cursor = comp.group_round_ends_at ?? null;
    items.push({ label: "第三名加赛 结算", at: cursor, note: cursor ? "" : "手动结算" });
  }

  if (comp.phase === "group" || comp.phase === "playoff") {
    for (let r = 1; r <= koRoundsTotal; r++) {
      cursor = cursor && comp.round_hours ? cursor + comp.round_hours * HOUR : null;
      items.push({ label: `${koLabel(koTarget >> (r - 1))} 结算`, at: cursor, note: cursor ? "" : "需设定每轮时长" });
    }
    items.push({ label: "决出冠军 🏆", at: null, note: "最后一轮结算后" });
    return items;
  }

  if (comp.phase === "knockout") {
    const koMs = db.matchups.filter((m) => m.competition_id === cid && m.stage === "knockout");
    const maxRound = koMs.length ? Math.max(...koMs.map((m) => m.round_no)) : 1;
    let contenders = Math.max(2, koMs.filter((m) => m.round_no === maxRound).length * 2);
    cursor = comp.ko_round_ends_at ?? null;
    let first = true;
    while (contenders >= 2) {
      if (!first) cursor = cursor && comp.round_hours ? cursor + comp.round_hours * HOUR : null;
      items.push({ label: `${koLabel(contenders)} 结算`, at: cursor, note: cursor ? "" : "需设定每轮时长" });
      first = false;
      contenders = contenders >> 1;
    }
    items.push({ label: "决出冠军 🏆", at: null, note: "最后一轮结算后" });
    return items;
  }

  return items; // finished
}
