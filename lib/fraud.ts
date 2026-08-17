import { readDb, writeDb, mergeGroups, topLevel, type DB } from "./db";
import { normalizeIp } from "./ip";

/**
 * 异常投票检测（QASML 刷票簇识别）。
 *
 * 纯读取、幂等、可重跑：本模块绝不修改投票数据，只输出「簇 + 证据 + 影响量化」，
 * 由管理员勾选后走现有的作废接口。所有判定都基于多个信号叠加（单一信号不足以定罪），
 * 且每条结论都带人类可读的中文证据，方便运营复核。
 *
 * 数据口径：身份 = voter_id（前端会话身份，清 Cookie 即更换）；
 *          设备指纹 = device_bucket（跨会话稳定）；网络 = normalizeIp(ip)（/64）。
 */

// ── 公开类型 ────────────────────────────────────────────────────────────────
export type FraudLevel = "high" | "medium" | "low";
export type ClusterKind = "identity_churn" | "duplicate_ballot" | "same_ip_cross_device" | "max_ballot_stacking";

export interface FraudSignal {
  code: string;        // S1..S7（以及反向信号 R1/R2）
  strength: number;    // 0..1
  weight: number;      // 该信号占的分值
  evidence: string;    // 中文说明，直接展示
}

export interface FraudIdentity {
  voterId: string;
  votes: number;
  firstAt: number;
  lastAt: number;
  candidates: number[];
  ipsFull: string[];
}

export interface FraudImpactRow {
  candidateId: number;
  nameCn: string;
  votesBefore: number;
  rankBefore: number;
  votesAfter: number;
  rankAfter: number;
  crossesCut: "in→out" | "out→in" | "none"; // 是否跨越晋级线
}

export interface FraudImpact {
  cutLine: number;       // 第 auto_size 名的票数
  tiedAtCutLine: number; // 与切线同票数的人数（提示需要 tiebreak）
  affected: FraudImpactRow[];
}

export interface FraudCluster {
  id: string;                 // 稳定 hash，用于「已复核」白名单
  kind: ClusterKind;
  score: number;
  level: FraudLevel;
  deviceBuckets: string[];
  ipsNorm: string[];
  identities: FraudIdentity[];
  totalVotes: number;
  signals: FraudSignal[];     // 命中的信号 + 证据
  reverse: { code: string; evidence: string }[]; // 反向信号（降分原因）
  timeline: { at: number; voterId: string; candidate: string; ip: string }[];
  impact: FraudImpact;
  reviewed: boolean;          // 已被管理员标记为已复核（误报）
}

export interface FraudReport {
  generatedAt: number;
  params: { competitionId: number; phase: string; windowMs: number; minScore: number };
  baseline: { buckets: number; identityDistribution: Record<number, number>; totalVotes: number };
  clusters: FraudCluster[];
  natSuspects: { ipNorm: string; identities: number; buckets: number }[];
  /** 传入 voterIds 时给出「这些身份全部作废」的合并影响预估。 */
  combinedImpact?: FraudImpact;
}

export interface FraudOptions {
  competitionId?: number;
  phase?: "nomination" | "approval" | "match";
  windowMs?: number;      // S2 突发窗口（默认 30min）
  minScore?: number;      // 低于此分数不输出（默认 20）
  voterIds?: string[];    // 附加：合并影响预览
}

// ── 内部类型 ────────────────────────────────────────────────────────────────
interface Vote {
  id: number;
  voter_id: string;
  candidate_id: number;
  created_at: number;
  device_bucket: string | null;
  ip: string | null;
}

interface Identity {
  voterId: string;
  deviceBucket: string | null;
  votes: Vote[];          // 按 created_at 升序
  candidates: Set<number>;
  firstAt: number;
  lastAt: number;
  ipsFull: Set<string>;
  ipsNorm: Set<string>;
  medianGapMs: number | null;
}

interface Ctx {
  db: DB;
  cid: number;
  phase: string;
  windowMs: number;
  nomMax: number;         // 每人提名上限（0 = 不限）
  autoSize: number;       // 晋级人数（0 = 未设定）
  nameOf: (id: number) => string;
}

// ── 阈值（来自真实数据复盘，可用环境变量覆盖）──────────────────────────────
function envNum(key: string, dflt: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
const S6_WINDOW_MS = envNum("SAIMOE_FRAUD_S6_MS", 5 * 60_000);       // S6：同候选时间差
const BURST_GAP_BONUS_MS = envNum("SAIMOE_FRAUD_BURST_GAP_MS", 3 * 60_000); // S2 加成阈值
const S5_MIN_RATIO = envNum("SAIMOE_FRAUD_S5_MIN_RATIO", 2);         // S5：票源集中度门槛（approval 多选模式基线不同，需重新校准）
const RATE_FAST_MS = 5_000;                                          // S4：中位间隔 <5s
const RATE_MAXED_SPAN_MS = 5 * 60_000;                               // S4：顶满且 5min 内
const LONG_SPAN_MS = 12 * 3600_000;                                  // R1：活跃跨度 >12h
const NAT_IDENT_MIN = 8;                                             // R3：身份数门槛
const NAT_BUCKET_RATIO = 0.6;                                        // R3：指纹数 ≈ 身份数
const NAT_JACCARD_MAX = 0.15;                                        // R3：票单几乎不相交

// ── 主入口 ──────────────────────────────────────────────────────────────────
export function generateFraudReport(opts: FraudOptions = {}): FraudReport {
  const db = readDb();
  const comps = db.competitions;
  const cid = opts.competitionId ?? (comps.length ? Math.max(...comps.map((c) => c.id)) : 0);
  const comp = comps.find((c) => c.id === cid);
  const phase = opts.phase ?? "nomination";
  const windowMs = opts.windowMs ?? 30 * 60_000;
  const minScore = opts.minScore ?? 20;
  const nomMax = comp?.nom_user_limit ?? 0;
  const autoSize = comp?.auto_size ?? 0;

  const nameOf = (id: number) => {
    const c = db.candidates.find((x) => x.id === id);
    return c ? (c.name_cn || c.name) : `#${id}`;
  };
  const ctx: Ctx = { db, cid, phase, windowMs, nomMax, autoSize, nameOf };

  const votes = loadVotes(db, cid, phase);
  const identities = buildIdentities(votes);

  // 基线：指纹数、身份数分布、总票数
  const byBucket = new Map<string, Set<string>>();
  for (const id of identities.values())
    if (id.deviceBucket) {
      if (!byBucket.has(id.deviceBucket)) byBucket.set(id.deviceBucket, new Set());
      byBucket.get(id.deviceBucket)!.add(id.voterId);
    }
  const identityDistribution: Record<number, number> = {};
  for (const s of byBucket.values())
    identityDistribution[s.size] = (identityDistribution[s.size] || 0) + 1;

  const reviewedSet = new Set(db.fraudReviewed || []);
  const clusters: FraudCluster[] = buildClusters(identities, ctx)
    .map((c) => ({ ...c, impact: impactOfVoters(db, cid, c.identities.map((i) => i.voterId), autoSize, nameOf), reviewed: reviewedSet.has(c.id) }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const report: FraudReport = {
    generatedAt: Date.now(),
    params: { competitionId: cid, phase, windowMs, minScore },
    baseline: { buckets: byBucket.size, identityDistribution, totalVotes: votes.length },
    clusters,
    natSuspects: detectNat(identities),
  };
  if (opts.voterIds && opts.voterIds.length)
    report.combinedImpact = impactOfVoters(db, cid, opts.voterIds, autoSize, nameOf);
  return report;
}

// ── 投票装载（三种投票表结构一致，按 phase 选表）────────────────────────────
function loadVotes(db: DB, cid: number, phase: string): Vote[] {
  const compMatchIds =
    phase === "match" ? new Set(db.matchups.filter((m) => m.competition_id === cid).map((m) => m.id)) : null;
  const out: Vote[] = [];
  const push = (v: Vote) => out.push(v);

  if (phase === "match") {
    for (const v of db.matchVotes) {
      if (!compMatchIds?.has(v.matchup_id)) continue;
      push({ id: v.id ?? 0, voter_id: v.voter_id, candidate_id: v.choice_id, created_at: v.created_at ?? 0, device_bucket: v.device_bucket ?? null, ip: v.ip ?? null });
    }
    return out;
  }
  const list = phase === "approval" ? db.approvalVotes : db.nominationVotes;
  for (const v of list) {
    if (v.competition_id !== cid) continue;
    push({ id: v.id ?? 0, voter_id: v.voter_id, candidate_id: v.candidate_id, created_at: v.created_at ?? 0, device_bucket: v.device_bucket ?? null, ip: v.ip ?? null });
  }
  return out;
}

function buildIdentities(votes: Vote[]): Map<string, Identity> {
  const byVoter = new Map<string, Identity>();
  for (const v of votes) {
    let id = byVoter.get(v.voter_id);
    if (!id) {
      id = {
        voterId: v.voter_id, deviceBucket: v.device_bucket, votes: [], candidates: new Set(),
        firstAt: Infinity, lastAt: -Infinity, ipsFull: new Set(), ipsNorm: new Set(), medianGapMs: null,
      };
      byVoter.set(v.voter_id, id);
    }
    id.votes.push(v);
    id.candidates.add(v.candidate_id);
    id.firstAt = Math.min(id.firstAt, v.created_at);
    id.lastAt = Math.max(id.lastAt, v.created_at);
    if (v.ip) {
      id.ipsFull.add(v.ip);
      const n = normalizeIp(v.ip);
      if (n) id.ipsNorm.add(n);
    }
  }
  for (const id of byVoter.values()) {
    id.votes.sort((a, b) => a.created_at - b.created_at);
    const gaps: number[] = [];
    for (let i = 1; i < id.votes.length; i++) gaps.push(id.votes[i].created_at - id.votes[i - 1].created_at);
    if (gaps.length) {
      gaps.sort((a, b) => a - b);
      id.medianGapMs = gaps[Math.floor(gaps.length / 2)];
    }
  }
  return byVoter;
}

// ── 聚类：同一指纹内「票单重叠」连通块 + 跨设备（S6）配对 ───────────────────
class UnionFind {
  private p: number[];
  constructor(n: number) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a: number, b: number) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[rb] = ra; }
}

function buildClusters(identities: Map<string, Identity>, ctx: Ctx): Omit<FraudCluster, "impact" | "reviewed">[] {
  const list = [...identities.values()];
  const uf = new UnionFind(list.length);

  // 同一指纹下，投过同一角色的两个身份视为「同一簇」（票单重叠是簇内关系的主证据；
  // 这让同指纹下「各 1 票且角色不相干」的身份自然落为孤立点，不会被卷进刷票簇）。
  const byBucket = new Map<string, number[]>();
  for (let i = 0; i < list.length; i++) {
    const b = list[i].deviceBucket;
    if (b) {
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b)!.push(i);
    }
  }
  for (const members of byBucket.values())
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++)
        if (shareCandidate(list[members[i]], list[members[j]])) uf.union(members[i], members[j]);

  // S6 跨设备：同一 /64 网络、不同指纹、同一角色、时间差 < T → 并入同一簇
  for (const [a, b] of findCrossDevicePairs(list)) uf.union(a, b);

  const compMap = new Map<number, number[]>();
  for (let i = 0; i < list.length; i++) {
    const r = uf.find(i);
    if (!compMap.has(r)) compMap.set(r, []);
    compMap.get(r)!.push(i);
  }

  const out: Omit<FraudCluster, "impact" | "reviewed">[] = [];
  for (const members of compMap.values()) {
    if (members.length < 2) continue; // 孤立身份不构成簇
    const cluster = scoreCluster(list, members, identities, ctx);
    if (cluster) out.push(cluster);
  }
  return out;
}

function shareCandidate(a: Identity, b: Identity): boolean {
  if (a.candidates.size === 0 || b.candidates.size === 0) return false;
  for (const c of a.candidates) if (b.candidates.has(c)) return true;
  return false;
}

/** 跨设备配对：同一 normalizeIp、不同 device_bucket、对同一角色投票且时间差 < T。 */
function findCrossDevicePairs(list: Identity[]): [number, number][] {
  const byIp = new Map<string, number[]>();
  for (let i = 0; i < list.length; i++)
    for (const n of list[i].ipsNorm)
      if (n) {
        if (!byIp.has(n)) byIp.set(n, []);
        byIp.get(n)!.push(i);
      }
  const pairs: [number, number][] = [];
  for (const members of byIp.values())
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        const a = list[members[i]], b = list[members[j]];
        if (!a.deviceBucket || !b.deviceBucket || a.deviceBucket === b.deviceBucket) continue;
        if (sharedCandidateMinGap(a, b) < S6_WINDOW_MS) pairs.push([members[i], members[j]]);
      }
  return pairs;
}

/** 两个身份对某个共同角色投票的最小时间差（毫秒）；无共同角色返回 Infinity。 */
function sharedCandidateMinGap(a: Identity, b: Identity): number {
  let min = Infinity;
  for (const c of a.candidates) {
    if (!b.candidates.has(c)) continue;
    const ta = a.votes.filter((v) => v.candidate_id === c).map((v) => v.created_at);
    const tb = b.votes.filter((v) => v.candidate_id === c).map((v) => v.created_at);
    for (const x of ta) for (const y of tb) min = Math.min(min, Math.abs(x - y));
  }
  return min;
}

// ── 打分 ────────────────────────────────────────────────────────────────────
const WEIGHTS: Record<string, number> = { S1: 30, S2: 25, S3: 25, S4: 10, S5: 15, S6: 20, S7: 20 };

function scoreCluster(list: Identity[], memberIdx: number[], identities: Map<string, Identity>, ctx: Ctx): Omit<FraudCluster, "impact" | "reviewed"> | null {
  const members = memberIdx.map((i) => list[i]);
  const signals: FraudSignal[] = [];
  const reverse: { code: string; evidence: string }[] = [];

  const bucketCounts = new Map<string, number>();
  for (const id of identities.values()) if (id.deviceBucket) bucketCounts.set(id.deviceBucket, (bucketCounts.get(id.deviceBucket) || 0) + 1);

  const sig = (code: string, strength: number, evidence: string) => {
    if (strength > 0) signals.push({ code, strength: Math.min(1, strength), weight: WEIGHTS[code] || 0, evidence });
  };

  // ── S1 指纹内身份更替 ──
  {
    let worstBucket: string | null = null, worstN = 0;
    for (const m of members) {
      if (!m.deviceBucket) continue;
      const n = bucketCounts.get(m.deviceBucket) || 0;
      if (n > worstN) { worstN = n; worstBucket = m.deviceBucket; }
    }
    if (worstBucket && worstN >= 3) {
      const inCluster = new Set(members.map((m) => m.voterId));
      const clusterN = members.filter((m) => m.deviceBucket === worstBucket).length;
      const s = Math.min(1, (worstN - 2) / 4);
      sig("S1", s, `设备指纹 ${short(worstBucket)} 共关联 ${worstN} 个投票身份（本簇 ${clusterN} 个），疑似清缓存/换浏览器反复切身份`);
    }
  }

  // ── S2 时间突发 ──
  const burst = detectBurst(members, ctx.windowMs);
  if (burst) {
    let s = Math.min(1, (burst.k - 2) / 3);
    const notes: string[] = [];
    if (burst.medGap < BURST_GAP_BONUS_MS) { s = Math.min(1, s * 1.3); notes.push("首投间隔中位数 <3 分钟"); }
    if (burst.interleaved) { s = Math.min(1, s * 1.3); notes.push("burst 期间切换过网络类型（IPv4↔IPv6），像是在换流量/换 WiFi"); }
    sig("S2", s, `${burst.k} 个身份在 ${Math.round(ctx.windowMs / 60_000)} 分钟内集中首投${notes.length ? "（" + notes.join("；") + "）" : ""}`);
  }

  // ── S3 票单重叠 ──
  {
    let best = { strength: 0, kind: "", a: "", b: "", val: 0 };
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        const A = members[i], B = members[j];
        if (!sameNetwork(A, B)) continue;
        const inter = intersection(A.candidates, B.candidates);
        if (!inter.length) continue;
        const uni = new Set([...A.candidates, ...B.candidates]).size;
        const jac = inter.length / uni;
        const cont = inter.length / Math.min(A.candidates.size, B.candidates.size);
        if (cont >= 0.9 && Math.min(A.candidates.size, B.candidates.size) >= 2 && cont > best.strength) {
          best = { strength: cont, kind: "dup", a: A.voterId, b: B.voterId, val: cont };
        } else if (jac >= 0.3 && A.candidates.size >= 5 && B.candidates.size >= 5 && jac > best.strength) {
          const mapped = Math.min(1, 0.5 + ((jac - 0.3) / 0.7) * 0.5);
          best = { strength: mapped, kind: "coop", a: A.voterId, b: B.voterId, val: jac };
        }
      }
    if (best.strength > 0) {
      sig("S3", best.strength, best.kind === "dup"
        ? `身份 ${short(best.a)} 的票单几乎被 ${short(best.b)} 完整包含（containment=${best.val.toFixed(2)}）——重复投票`
        : `身份 ${short(best.a)} 与 ${short(best.b)} 票单高度重叠（jaccard=${best.val.toFixed(2)}）——协同刷票`);
    }
  }

  // ── S4 投票速率（单独不足以定罪）──
  {
    let best = { strength: 0, voterId: "", span: 0, votes: 0, med: 0 };
    for (const m of members) {
      let s = 0;
      if (m.votes.length >= 5 && m.medianGapMs != null && m.medianGapMs < RATE_FAST_MS) s = Math.max(s, 0.7);
      if (ctx.nomMax > 0 && m.votes.length === ctx.nomMax && m.lastAt - m.firstAt < RATE_MAXED_SPAN_MS) s = 1.0;
      if (s > best.strength) best = { strength: s, voterId: m.voterId, span: m.lastAt - m.firstAt, votes: m.votes.length, med: m.medianGapMs ?? 0 };
    }
    if (best.strength > 0) {
      sig("S4", best.strength,
        `身份 ${short(best.voterId)} ${Math.round(best.span / 1000)} 秒内投完 ${best.votes} 票（中位间隔 ${(best.med / 1000).toFixed(1)}s）——速率异常`);
    }
  }

  // ── S5 票源集中度（对 burst 身份集合整体计算）──
  if (burst) {
    const setVotes = burst.members.reduce((t, m) => t + m.votes.length, 0);
    const distinct = new Set<number>();
    for (const m of burst.members) for (const c of m.candidates) distinct.add(c);
    const ratio = setVotes / Math.max(1, distinct.size);
    if (ratio >= S5_MIN_RATIO) {
      sig("S5", Math.min(1, (ratio - 1) / 2), `票源高度集中：${setVotes} 票只投了 ${distinct.size} 个不同角色（repeatRatio=${ratio.toFixed(2)}）——像在给少数几个角色刷票`);
    }
  }

  // ── S6 同网络跨指纹短间隔同角色（补「按指纹分组」盲区）──
  {
    let best = { strength: 0, a: "", b: "", dt: 0, ip: "", cand: 0 };
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        const A = members[i], B = members[j];
        if (!A.deviceBucket || !B.deviceBucket || A.deviceBucket === B.deviceBucket) continue;
        const dt = sharedCandidateMinGap(A, B);
        if (dt >= S6_WINDOW_MS || dt === Infinity) continue;
        const ip = [...A.ipsNorm].find((n) => B.ipsNorm.has(n));
        if (!ip) continue;
        const s = 1 - dt / S6_WINDOW_MS;
        if (s > best.strength) best = { strength: s, a: A.voterId, b: B.voterId, dt, ip, cand: findSharedCandidate(A, B) };
      }
    if (best.strength > 0) {
      sig("S6", best.strength,
        `身份 ${short(best.a)} 与 ${short(best.b)} 在 ${Math.round(best.dt / 1000)}s 内从同一网络 ${best.ip} 投了同一角色「${ctx.nameOf(best.cand)}」——跨设备切身份继续投（现有按指纹分组看不到）`);
    }
  }

  // ── S7 顶满上限堆叠 ──
  if (ctx.nomMax > 0) {
    const maxed = members.filter((m) => m.votes.length === ctx.nomMax);
    if (maxed.length >= 2) {
      sig("S7", Math.min(1, (maxed.length - 1) / 2), `本簇有 ${maxed.length} 个身份各投满上限 ${ctx.nomMax} 票（合计 ${maxed.length * ctx.nomMax} 票）——顶满堆叠`);
    }
  }

  // ── 反向信号（降分，防误杀）──
  let penalty = 1;
  const span = Math.max(...members.map((m) => m.lastAt)) - Math.min(...members.map((m) => m.firstAt));
  const avgJac = avgPairwiseJaccard(members);
  if (span > LONG_SPAN_MS && avgJac < 0.2) {
    penalty *= 0.4;
    reverse.push({ code: "R1", evidence: `活跃跨度 ${(span / 3600_000).toFixed(1)}h>12h 且票单几乎互不相同（jaccard=${avgJac.toFixed(2)}）——像真人分批投票，总分 ×0.4` });
  }
  const totalVotes = members.reduce((t, m) => t + m.votes.length, 0);
  const distinctCands = new Set<number>();
  for (const m of members) for (const c of m.candidates) distinctCands.add(c);
  const repeatRatio = totalVotes / Math.max(1, distinctCands.size);
  if (repeatRatio < 1.2) {
    penalty *= 0.5;
    reverse.push({ code: "R2", evidence: `没有任何角色被重复投票（repeatRatio=${repeatRatio.toFixed(2)}<1.2）——不像在给谁刷票，总分 ×0.5` });
  }

  const raw = signals.reduce((t, s) => t + s.weight * s.strength, 0);
  const score = Math.min(100, raw * penalty);
  if (score < 1) return null; // 几乎没信号，不构成簇

  const deviceBuckets = [...new Set(members.map((m) => m.deviceBucket).filter((x): x is string => !!x))];
  const ipsNorm = [...new Set(members.flatMap((m) => [...m.ipsNorm]).filter((x): x is string => !!x))];
  const timeline = members
    .flatMap((m) => m.votes.map((v) => ({ at: v.created_at, voterId: m.voterId, candidate: ctx.nameOf(v.candidate_id), ip: v.ip || "—" })))
    .sort((a, b) => a.at - b.at);

  return {
    id: clusterId(members.map((m) => m.voterId)),
    kind: kindOf(signals),
    score: Math.round(score),
    level: score >= 70 ? "high" : score >= 40 ? "medium" : "low",
    deviceBuckets,
    ipsNorm,
    identities: members
      .map((m) => ({ voterId: m.voterId, votes: m.votes.length, firstAt: m.firstAt, lastAt: m.lastAt, candidates: [...m.candidates].sort((a, b) => a - b), ipsFull: [...m.ipsFull] }))
      .sort((a, b) => b.votes - a.votes),
    totalVotes,
    signals: signals.sort((a, b) => b.weight * b.strength - a.weight * a.strength),
    reverse,
    timeline,
  };
}

function kindOf(signals: FraudSignal[]): ClusterKind {
  const has = (code: string) => signals.some((s) => s.code === code);
  // 优先级：跨设备 → 顶满堆叠 → 指纹内更替 → 票单重复。
  // 顶满（S7）优先于重复（S3）：3 个身份各投满 16 票且票单几乎一致时，主标签应说「堆叠」而非「重复」。
  if (has("S6")) return "same_ip_cross_device";
  if (has("S7")) return "max_ballot_stacking";
  if (has("S1") || has("S2")) return "identity_churn";
  if (has("S3")) return "duplicate_ballot";
  return "identity_churn";
}

function clusterId(voterIds: string[]): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  const s = [...voterIds].sort().join("|");
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  return (h1 ^ h2).toString(16).padStart(8, "0");
}

// ── 检测工具 ────────────────────────────────────────────────────────────────
interface Burst { k: number; members: Identity[]; medGap: number; interleaved: boolean; }

function detectBurst(members: Identity[], windowMs: number): Burst | null {
  if (members.length < 3) return null;
  const arr = members.map((m) => ({ m, t: m.firstAt })).sort((a, b) => a.t - b.t);
  let best: Identity[] = [];
  for (let lo = 0; lo < arr.length; lo++) {
    let hi = lo;
    while (hi < arr.length && arr[hi].t - arr[lo].t <= windowMs) hi++;
    if (hi - lo > best.length) best = arr.slice(lo, hi).map((x) => x.m);
  }
  if (best.length < 3) return null;
  const firsts = best.map((m) => m.firstAt).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < firsts.length; i++) gaps.push(firsts[i] - firsts[i - 1]);
  gaps.sort((a, b) => a - b);
  const ipTypes = new Set<string>();
  for (const m of best) for (const ip of m.ipsFull) ipTypes.add(ip.includes(":") ? "6" : "4");
  return { k: best.length, members: best, medGap: gaps[Math.floor(gaps.length / 2)] ?? 0, interleaved: ipTypes.has("4") && ipTypes.has("6") };
}

function sameNetwork(a: Identity, b: Identity): boolean {
  if (a.deviceBucket && a.deviceBucket === b.deviceBucket) return true;
  for (const n of a.ipsNorm) if (b.ipsNorm.has(n)) return true;
  return false;
}

function intersection(a: Set<number>, b: Set<number>): number[] {
  const out: number[] = [];
  for (const x of a) if (b.has(x)) out.push(x);
  return out;
}

function findSharedCandidate(a: Identity, b: Identity): number {
  for (const c of a.candidates) if (b.candidates.has(c)) return c;
  return 0;
}

function avgPairwiseJaccard(members: Identity[]): number {
  let sum = 0, n = 0;
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const inter = intersection(members[i].candidates, members[j].candidates).length;
      const uni = new Set([...members[i].candidates, ...members[j].candidates]).size;
      sum += uni ? inter / uni : 0;
      n++;
    }
  return n ? sum / n : 0;
}

/** R3：疑似 NAT 出口 —— 身份数多、指纹数≈身份数、票单几乎互不相交。仅标记、不作为簇输出。 */
function detectNat(identities: Map<string, Identity>): { ipNorm: string; identities: number; buckets: number }[] {
  const byIp = new Map<string, Identity[]>();
  for (const id of identities.values())
    for (const n of id.ipsNorm)
      if (n) {
        if (!byIp.has(n)) byIp.set(n, []);
        byIp.get(n)!.push(id);
      }
  const out: { ipNorm: string; identities: number; buckets: number }[] = [];
  for (const [ip, list] of byIp) {
    if (list.length < NAT_IDENT_MIN) continue;
    const buckets = new Set(list.map((i) => i.deviceBucket).filter((x): x is string => !!x)).size;
    const ratio = buckets / list.length;
    const jac = avgPairwiseJaccard(list);
    if (ratio >= NAT_BUCKET_RATIO && jac < NAT_JACCARD_MAX)
      out.push({ ipNorm: ip, identities: list.length, buckets });
  }
  return out.sort((a, b) => b.identities - a.identities);
}

// ── 影响量化（第 5 节：模块价值核心，不能省）────────────────────────────────
/**
 * 把指定 voter 的全部票剔除后，按提名规则（合并组去重 + 取前 auto_size）重新排名，
 * 给出切线、平票人数与受影响角色（票数变化 / 跨越晋级线）。
 */
function impactOfVoters(db: DB, cid: number, voterIds: string[], autoSize: number, nameOf: (id: number) => string): FraudImpact {
  const voidSet = new Set(voterIds);
  const before = rankVotes(db, cid, db.nominationVotes);
  const after = rankVotes(
    db, cid,
    db.nominationVotes.filter((v) => !(v.competition_id === cid && voidSet.has(v.voter_id))),
  );
  const N = Math.max(0, autoSize);
  const cutLine = N > 0 && after.length ? (after[Math.min(N, after.length) - 1].votes ?? 0) : 0;
  const tiedAtCutLine = N > 0 && after.length ? after.filter((x) => x.votes === cutLine).length : 0;

  const beforeIdx = new Map(before.map((r, i) => [r.id, i]));
  const affected: FraudImpactRow[] = [];
  after.forEach((r, i) => {
    const bIdx = beforeIdx.get(r.id);
    const b = bIdx != null ? before[bIdx] : r;
    if (b.votes === r.votes) return; // 票数没变，不直接影响
    const inBefore = N > 0 && bIdx != null && bIdx < N;
    const inAfter = N > 0 && i < N;
    affected.push({
      candidateId: r.id,
      nameCn: nameOf(r.id),
      votesBefore: b.votes,
      rankBefore: bIdx != null ? bIdx + 1 : -1,
      votesAfter: r.votes,
      rankAfter: i + 1,
      crossesCut: inBefore && !inAfter ? "in→out" : !inBefore && inAfter ? "out→in" : "none",
    });
  });
  affected.sort((a, b) => (b.crossesCut === "in→out" ? 1 : 0) - (a.crossesCut === "in→out" ? 1 : 0) || b.votesBefore - a.votesBefore);
  return { cutLine, tiedAtCutLine, affected };
}

/** 按合并组去重后的提名票数给「顶层」角色排名（与 startGroups 的晋级口径一致）。 */
function rankVotes(db: DB, cid: number, votes: { competition_id: number; candidate_id: number; voter_id: string }[]): { id: number; votes: number }[] {
  const groups = mergeGroups(db, cid);
  const total = new Map<number, number>();
  for (const [parent, ids] of groups) {
    const voters = new Set<string>();
    for (const id of ids) for (const v of votes) if (v.competition_id === cid && v.candidate_id === id) voters.add(v.voter_id);
    total.set(parent, voters.size);
  }
  const list = topLevel(db, cid).map((c) => ({ id: c.id, votes: total.get(c.id) || 0 }));
  list.sort((a, b) => b.votes - a.votes || a.id - b.id);
  return list;
}

/** 公开入口：计算「这些身份全部作废」对晋级结果的影响（不修改任何数据）。 */
export function computeImpact(cid: number, voterIds: string[]): FraudImpact {
  const db = readDb();
  const comp = db.competitions.find((c) => c.id === cid);
  const autoSize = comp?.auto_size ?? 0;
  const nameOf = (id: number) => {
    const c = db.candidates.find((x) => x.id === id);
    return c ? (c.name_cn || c.name) : `#${id}`;
  };
  return impactOfVoters(db, cid, voterIds, autoSize, nameOf);
}

// ── 白名单 ──────────────────────────────────────────────────────────────────
export function readReviewed(): Set<string> {
  return new Set(readDb().fraudReviewed || []);
}
export function setReviewed(ids: string[], reviewed: boolean): void {
  const db = readDb();
  const cur = new Set(db.fraudReviewed || []);
  for (const id of ids) (reviewed ? cur.add(id) : cur.delete(id));
  db.fraudReviewed = [...cur];
  writeDb(db);
}

/** 给 admin 展示用的短 id（截 8 位十六进制，与后台现有 UI 一致）。 */
export function short(s: string, n = 8): string {
  const v = String(s || "");
  const core = v.replace(/^sid_/, "");
  return core.length <= n ? core : core.slice(0, n);
}
