import { readDb, approvalTally, nominationTally } from "./db";
import { groupLabel } from "./i18n";

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
// 下面三个信号来自真实数据的复盘：单看「同指纹多身份」会把同型号手机误判，
// 而真正的刷票在时间接续、票单重叠、用满上限这三点上同时露出马脚。
const HANDOFF_MS = envNum("SAIMOE_OBS_HANDOFF_MS", 120_000); // 同设备上一身份投完到下一身份开投的间隔
const OVERLAP_MIN = envNum("SAIMOE_OBS_OVERLAP_MIN", 4);     // 两个身份投出的相同角色数
const MAXED_MIN = envNum("SAIMOE_OBS_MAXED_MIN", 2);         // 同设备上「用满提名上限」的身份数
const COVERAGE_MIN_MATCHES = 10;                          // don't flag coverage until the field is big enough

export type FlagType = "device" | "ip" | "burst" | "coverage" | "handoff" | "overlap" | "maxed";
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

  interface Ev { voter: string; bucket: string | null; ip: string | null; ts: number | null; matchId: number | null; target: number | null; }
  const evs: Ev[] = [];
  for (const v of db.matchVotes) if (compMatchIds.has(v.matchup_id))
    evs.push({ voter: v.voter_id, bucket: v.device_bucket ?? null, ip: v.ip ?? null, ts: v.created_at ?? null, matchId: v.matchup_id, target: v.choice_id });
  for (const v of db.nominationVotes) if (v.competition_id === cid)
    evs.push({ voter: v.voter_id, bucket: v.device_bucket ?? null, ip: v.ip ?? null, ts: v.created_at ?? null, matchId: null, target: v.candidate_id });
  // approval-mode group votes (no matchup_id): fold in so device/IP/burst detection covers them too
  for (const v of db.approvalVotes) if (v.competition_id === cid)
    evs.push({ voter: v.voter_id, bucket: v.device_bucket ?? null, ip: v.ip ?? null, ts: v.created_at ?? null, matchId: null, target: v.candidate_id });

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
        detail: `同一设备指纹关联 ${g.voters.size} 个投票身份、共 ${g.votes} 票（疑似一台设备多浏览器/无痕刷票）` });
  });

  // 1b) 交接：同一设备上，一个身份投完后极短时间内出现另一个新身份继续投。
  //     这是「清缓存/开无痕换身份」最直接的痕迹，比单纯的身份数可靠得多。
  const comp0 = db.competitions.find((c) => c.id === cid);
  const nomLimit = comp0?.nom_user_limit ?? 0;
  const bucketEvs = new Map<string, Ev[]>();
  evs.forEach((e) => { if (e.bucket && e.ts != null) { const a = bucketEvs.get(e.bucket) || []; a.push(e); bucketEvs.set(e.bucket, a); } });
  bucketEvs.forEach((list, k) => {
    const span = new Map<string, { first: number; last: number; targets: Set<number>; n: number }>();
    for (const e of list) {
      const g = span.get(e.voter) || { first: e.ts!, last: e.ts!, targets: new Set<number>(), n: 0 };
      g.first = Math.min(g.first, e.ts!); g.last = Math.max(g.last, e.ts!);
      if (e.target != null) g.targets.add(e.target);
      g.n++; span.set(e.voter, g);
    }
    const ids = [...span.entries()].sort((a, b) => a[1].first - b[1].first);
    if (ids.length < 2) return;
    // 交接
    const handoffs: string[] = [];
    for (let i = 1; i < ids.length; i++) {
      const gap = ids[i][1].first - ids[i - 1][1].last;
      if (gap >= 0 && gap <= HANDOFF_MS) handoffs.push(`${Math.round(gap / 1000)}s`);
    }
    if (handoffs.length)
      flags.push({ type: "handoff", by: "bucket", key: k, keyShort: short(k), identities: ids.length, votes: list.length,
        detail: `同一设备上身份接续出现（间隔 ${handoffs.join("、")}），像是清缓存/无痕后换身份继续投` });
    // 票单重叠
    let worst = 0, pair = "";
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      let same = 0; ids[i][1].targets.forEach((t) => { if (ids[j][1].targets.has(t)) same++; });
      if (same > worst) { worst = same; pair = `${short(ids[i][0])} / ${short(ids[j][0])}`; }
    }
    if (worst >= OVERLAP_MIN)
      flags.push({ type: "overlap", by: "bucket", key: k, keyShort: short(k), identities: ids.length, votes: list.length,
        detail: `同一设备上两个身份投出的角色高度重叠（${pair} 有 ${worst} 个相同），不像各自独立选择` });
    // 用满上限
    if (nomLimit > 0) {
      const maxed = ids.filter(([, g]) => g.n >= nomLimit).length;
      if (maxed >= MAXED_MIN)
        flags.push({ type: "maxed", by: "bucket", key: k, keyShort: short(k), identities: ids.length, votes: list.length,
          detail: `同一设备上有 ${maxed} 个身份各自用满提名上限（${nomLimit} 票），正常用户很少恰好投满` });
    }
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
        detail: `同一 IP 关联 ${g.voters.size} 个身份、共 ${g.votes} 票（注意：NAT/校园网下多人可能共用 IP）` });
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
        detail: `该身份在 ${Math.round(BURST_WINDOW_MS / 1000)} 秒内投出 ${best} 票（共 ${tsArr.length} 票），疑似脚本` });
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
          detail: `该身份投了 ${s.size}/${totalMatches} 场（${Math.round(pct * 100)}%），覆盖率异常高` });
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
    items.push({ label: "提名截止", at: comp.nom_ends_at ?? null, note: comp.nom_ends_at ? "" : "未定时（需手动开赛）" });
    items.push({ label: "小组赛开始", at: null, note: "提名截止后；比赛日数在开赛时确定" });
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
      if ((koTarget >> (r - 1)) === 2 && comp.third_place !== false && koTarget >= 4) items.push({ label: "季军战 结算", at: cursor, note: "与决赛同期" });
    }
    items.push({ label: "决出冠军 🏆", at: null, note: "最后一轮结算后" });
    return items;
  }

  if (comp.phase === "knockout") {
    const koMs = db.matchups.filter((m) => m.competition_id === cid && m.stage === "knockout");
    const normal = koMs.filter((m) => !(m as any).bronze); // #13: bronze shares the final round — don't let it inflate the count
    const hasBronze = koMs.some((m) => (m as any).bronze);
    const maxRound = normal.length ? Math.max(...normal.map((m) => m.round_no)) : 1;
    let contenders = Math.max(2, normal.filter((m) => m.round_no === maxRound).length * 2);
    cursor = comp.ko_round_ends_at ?? null;
    let first = true;
    while (contenders >= 2) {
      if (!first) cursor = cursor && comp.round_hours ? cursor + comp.round_hours * HOUR : null;
      items.push({ label: `${koLabel(contenders)} 结算`, at: cursor, note: cursor ? "" : "需设定每轮时长" });
      if (contenders === 2 && hasBronze) items.push({ label: "季军战 结算", at: cursor, note: "与决赛同期" });
      first = false;
      contenders = contenders >> 1;
    }
    items.push({ label: "决出冠军 🏆", at: null, note: "最后一轮结算后" });
    return items;
  }

  return items; // finished
}

/** Admin-only UNMASKED live tallies (public state hides these mid-match). */
export function liveTallies(cid: number): {
  mode: "approval" | "match" | "none";
  groups?: { group: number; rows: { name: string; votes: number }[] }[];
  matches?: { label: string; a: string; va: number; b: string; vb: number; decided: boolean }[];
} {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  if (!comp) return { mode: "none" };
  const nm = (id: number) => { const c = db.candidates.find((x) => x.id === id); return c ? (c.name_cn || c.name) : "?"; };

  if (comp.phase === "group" && (comp.group_mode ?? "approval") === "approval") {
    const tally = approvalTally(db, cid);
    const byG = new Map<number, { name: string; votes: number }[]>();
    for (const c of db.candidates) {
      if (c.competition_id !== cid || c.group_no == null) continue;
      if (!byG.has(c.group_no)) byG.set(c.group_no, []);
      byG.get(c.group_no)!.push({ name: nm(c.id), votes: tally.get(c.id) || 0 });
    }
    const groups = [...byG.entries()].sort((a, b) => a[0] - b[0]).map(([group, rows]) => ({ group, rows: rows.sort((x, y) => y.votes - x.votes) }));
    return { mode: "approval", groups };
  }
  // matchup-based (rr group / knockout / playoff): count votes per side
  const count = new Map<string, number>();
  for (const v of db.matchVotes) count.set(v.matchup_id + ":" + v.choice_id, (count.get(v.matchup_id + ":" + v.choice_id) || 0) + 1);
  const stages = comp.phase === "group" ? ["group"] : comp.phase === "knockout" ? ["knockout"] : comp.phase === "playoff" ? ["playoff"] : [];
  const matches = db.matchups
    .filter((m) => m.competition_id === cid && stages.includes(m.stage))
    .map((m) => ({ label: m.stage === "group" ? `${groupLabel((m.group_no ?? 0))}组` : m.stage, a: nm(m.a_id), va: count.get(m.id + ":" + m.a_id) || 0, b: nm(m.b_id), vb: count.get(m.id + ":" + m.b_id) || 0, decided: m.decided }));
  return { mode: "match", matches };
}

/** 资料缺失盘点（admin）。开赛前用来把「缺中文名/缺英文名/缺日文原名/缺作品名/缺图」的角色
 *  一次列出来，而不是等它们出现在赛程页上才发现。 */
export function dataGaps(cid: number): {
  total: number;
  counts: { nameZh: number; nameJa: number; nameEn: number; subjectZh: number; subjectJa: number; subjectEn: number; image: number };
  rows: {
    id: number; bgmId: string; label: string; missing: string[]; mergedInto: string | null; votes: number;
    // 当前值，供后台就地编辑（非提名阶段 state 里没有提名池，只能由这里带出来）
    name: string; nameCn: string; nameEn: string; image: string;
    subjectName: string; subjectNameJa: string; subjectNameEn: string;
  }[];
} {
  const db = readDb();
  const list = db.candidates.filter((c) => c.competition_id === cid);
  const counts = { nameZh: 0, nameJa: 0, nameEn: 0, subjectZh: 0, subjectJa: 0, subjectEn: 0, image: 0 };
  const has = (v?: string | null) => !!(v && String(v).trim());
  const nameById = new Map(list.map((c) => [c.id, c.name_cn || c.name || c.bgm_id]));
  const { total: nomTotal, own: nomOwn } = nominationTally(db, cid);
  const rows: {
    id: number; bgmId: string; label: string; missing: string[]; mergedInto: string | null; votes: number;
    name: string; nameCn: string; nameEn: string; image: string;
    subjectName: string; subjectNameJa: string; subjectNameEn: string;
  }[] = [];
  for (const c of list) {
    const missing: string[] = [];
    if (!has(c.name_cn)) { missing.push("中文名"); counts.nameZh++; }
    if (!has(c.name)) { missing.push("日文名"); counts.nameJa++; }
    if (!has(c.name_en)) { missing.push("英文名"); counts.nameEn++; }
    if (!has(c.subject_name)) { missing.push("作品中文"); counts.subjectZh++; }
    if (!has(c.subject_name_ja)) { missing.push("作品日文"); counts.subjectJa++; }
    if (!has(c.subject_name_en)) { missing.push("作品英文"); counts.subjectEn++; }
    if (!has(c.image)) { missing.push("照片"); counts.image++; }
    if (missing.length) rows.push({
      id: c.id, bgmId: c.bgm_id, label: c.name_cn || c.name || c.bgm_id, missing,
      mergedInto: c.parent_id != null ? (nameById.get(c.parent_id) || null) : null,
      votes: c.parent_id == null ? (nomTotal.get(c.id) || 0) : (nomOwn.get(c.id) || 0),
      name: c.name || "", nameCn: c.name_cn || "", nameEn: c.name_en || "", image: c.image || "",
      subjectName: c.subject_name || "", subjectNameJa: c.subject_name_ja || "", subjectNameEn: c.subject_name_en || "",
    });
  }
  // 缺得最多的排前面，方便优先补
  // 票数高的排前面：人气角色的资料最该先补齐（缺失项数只作次级排序）
  rows.sort((a, b) => b.votes - a.votes || b.missing.length - a.missing.length || a.label.localeCompare(b.label));
  return { total: list.length, counts, rows: rows.slice(0, 300) };
}
