// 异常投票检测验收测试 —— 用例 A–H（取自真实数据的复盘）。
// 运行：npx tsx scripts/fraud-test.mts   （DATA_DIR 指向一次性临时目录）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWN_DIR = !process.env.SMOKE_DATA_DIR;
process.env.DATA_DIR = process.env.SMOKE_DATA_DIR || mkdtempSync(join(tmpdir(), "saimoe-fraud-"));
if (OWN_DIR) process.on("exit", () => { try { rmSync(process.env.DATA_DIR!, { recursive: true, force: true }); } catch {} });

const db = await import("../lib/db");
const fraud = await import("../lib/fraud");
const ip = await import("../lib/ip");
const { writeDb } = db;

let failures = 0;
const check = (label: string, cond: boolean) => {
  if (cond) console.log("  ok  " + label);
  else { console.error("FAIL " + label); failures++; }
};
const ts = (s: string) => Date.parse(s.endsWith("Z") ? s : s + "Z");

// ── 造库 ─────────────────────────────────────────────────────────────────────
const CID = 2, AUTO = 48, NOM_MAX = 16;
const candidates: any[] = [];
const nominationVotes: any[] = [];
let candSeq = 207, voteSeq = 0;

const cand = (name: string) => {
  const id = ++candSeq;
  candidates.push({ id, competition_id: CID, bgm_id: "bgm" + id, name, name_cn: name, image: null, group_no: null, seed: null, eliminated: false, subject_name: null, added_by: null, name_en: null, aliases: [], parent_id: null });
  return id;
};
const v = (candidateId: number, voterId: string, at: string, bucket: string | null, ip: string | null) => {
  nominationVotes.push({ id: ++voteSeq, competition_id: CID, candidate_id: candidateId, voter_id: voterId, created_at: ts(at), device_bucket: bucket, ip });
};
const votesFor = (voterId: string, at: string, bucket: string | null, ip: string | null, picks: { id: number; t: number }[]) => {
  for (const p of picks) v(p.id, voterId, at, bucket, ip);
};
// 按秒偏移生成一串票（用于「N 秒内投完 N 票」）
const spread = (base: string, secs: number[], n: number) => {
  const t0 = ts(base);
  return secs.map((s) => ({ t: t0 + s * 1000 }));
};

// 命名角色
const IDS = {
  lokisi: cand("洛琪希"), kafuka: cand("温水佳树"), shiroko: cand("白井黑子"),
  ino: cand("伊井野弥子"), yukino: cand("雪之下雪乃"), mikoto: cand("御坂美琴"),
  rikka: cand("小鸟游六花"), rin: cand("远坂凛"), yuno: cand("我妻由乃"),
  momoka: cand("河原木桃香"), chiyoda: cand("千代田桃"), uika: cand("三角初华"),
  madoka: cand("鹿目圆香"), marisa: cand("雾雨魔理沙"), reimu: cand("博丽灵梦"), sakuya: cand("十六夜咲夜"),
};
const FILLER = Array.from({ length: 60 }, (_, i) => cand("角色" + (i + 1)));

// 背景票：每个填充角色 4 票，来自 4 个独立身份（无指纹、独立 IP）→ 切线落在 4 票
FILLER.forEach((cid, i) => {
  for (let k = 0; k < 4; k++) v(cid, `bg_${i}_${k}`, "2026-08-16T08:00:00Z", null, `198.18.${Math.floor(i / 16)}.${i % 16 * 4 + k}`);
});

const bA = "4350ad3b79409e4ac024b6" + "0".repeat(40);
const bB = "4aa31ee0ab" + "1".repeat(54);
const bC = "b7198d55b8" + "2".repeat(54);
const bD1 = "9db49fdd" + "3".repeat(56);
const bD2 = "715a048f" + "4".repeat(56);
const bG = "7e67a09fbe" + "5".repeat(54);
const ipA6 = (s: string) => `2408:8418:d20:aaaa:bbbb:cccc:dddd:${s}`;
const ipE6 = (s: string) => `2408:8214:d11:7751:${s}`;
const ipG = (n: number) => `203.0.113.${n}`;

// ── 用例 A：指纹内身份更替 + 集中刷票（高）────────────────────────────────
// 4 个身份在同一指纹下交替投票，IPv6↔IPv4 互跳，9 票集中在 3 个角色
const A = ["c948e791", "7bcc613f", "54a79c18", "d64f2ca8"];
v(IDS.lokisi, "c948e791", "2026-08-17T10:50:37Z", bA, ipA6("1"));
v(IDS.shiroko, "c948e791", "2026-08-17T10:50:39Z", bA, ipA6("1"));
v(IDS.kafuka, "7bcc613f", "2026-08-17T10:51:32Z", bA, "112.224.195.158");
v(IDS.lokisi, "7bcc613f", "2026-08-17T10:51:43Z", bA, "112.224.195.158");
v(IDS.lokisi, "54a79c18", "2026-08-17T10:53:50Z", bA, "112.224.195.158");
v(IDS.kafuka, "54a79c18", "2026-08-17T10:54:08Z", bA, "112.224.195.158");
v(IDS.lokisi, "d64f2ca8", "2026-08-17T10:55:21Z", bA, ipA6("2"));
v(IDS.shiroko, "d64f2ca8", "2026-08-17T10:55:39Z", bA, ipA6("2"));
v(IDS.kafuka, "d64f2ca8", "2026-08-17T11:00:08Z", bA, ipA6("2"));

// 用例 F：同指纹下的两个「无辜」身份（各 1 票、角色与刷票簇不重合）
v(IDS.rikka, "1b660293", "2026-08-17T10:52:00Z", bA, ipA6("3"));
v(IDS.rin, "628b0fe1", "2026-08-17T10:57:00Z", bA, ipA6("3"));

// ── 用例 B / E：重复投票 + 长时间跨度正常身份 ─────────────────────────────
// 4aa31ee0：12 票、12 个互不重复的角色、跨 ~29h、IP 在同一 /64 内变化
const ePick = [IDS.lokisi, IDS.kafuka, IDS.shiroko, IDS.ino, IDS.mikoto, IDS.yukino, IDS.rikka, IDS.rin, IDS.yuno, IDS.momoka, IDS.chiyoda, IDS.uika];
const eStarts = ["2026-08-16T10:23:00Z", "2026-08-16T12:00:00Z", "2026-08-16T15:30:00Z", "2026-08-16T18:00:00Z", "2026-08-16T21:00:00Z", "2026-08-17T00:00:00Z", "2026-08-17T03:00:00Z", "2026-08-17T06:00:00Z", "2026-08-17T09:00:00Z", "2026-08-17T12:00:00Z", "2026-08-17T14:00:00Z", "2026-08-17T15:19:39Z"];
ePick.forEach((cid, i) => {
  // 每个角色在 /64 内不同后缀（但同一 /64）
  const sfx = ["5db1:1:2:3", "6c4c:1:2:3", "9c0e:1:2:3", "3f01:1:2:3", "aa11:1:2:3", "bb22:1:2:3", "cc33:1:2:3", "dd44:1:2:3", "ee55:1:2:3", "ff66:1:2:3", "1010:1:2:3", "5db1:1:2:4"];
  v(cid, "4aa31ee0", eStarts[i], bB, ipE6(sfx[i]));
});
// 64808741：3 票全部被 4aa31ee0 票单包含；雪之下雪乃相隔 66s、同一完整 IP
v(IDS.mikoto, "64808741", "2026-08-17T15:18:00Z", bB, ipE6("5db1:1:2:3"));
v(IDS.ino, "64808741", "2026-08-17T15:19:00Z", bB, ipE6("5db1:1:2:3"));
v(IDS.yukino, "64808741", "2026-08-17T15:20:45Z", bB, ipE6("5db1:1:2:3")); // 与 4aa31ee0 的雪之下雪乃(15:19:39)同一完整 IP

// ── 用例 C：顶满上限堆叠（高）──────────────────────────────────────────────
// 3 个身份各投满 16 票，同一 IP 221.0.177.39，票单几乎一致
const cSet = [IDS.yuno, IDS.momoka, IDS.chiyoda, IDS.uika, IDS.madoka, IDS.mikoto, IDS.yukino, IDS.shiroko, IDS.lokisi, IDS.kafuka, IDS.ino, IDS.rikka, IDS.rin, IDS.marisa, IDS.reimu, IDS.sakuya];
// 41ae6c48：71 秒投完 16 票
const t1 = ts("2026-08-17T09:00:00Z");
cSet.forEach((cid, i) => v(cid, "41ae6c48", new Date(t1 + i * 4400).toISOString().replace(/\.\d{3}Z$/, "Z"), bC, "221.0.177.39"));
// 3f6f98b3：前者结束后 18s 接上，2 分 47 秒投完
const t2 = t1 + 71_000 + 18_000;
cSet.forEach((cid, i) => v(cid, "3f6f98b3", new Date(t2 + i * (167_000 / 16)).toISOString().replace(/\.\d{3}Z$/, "Z"), bC, "221.0.177.39"));
// 第三个身份：稍后开始，同样 16 票
const t3 = t2 + 120_000;
cSet.forEach((cid, i) => v(cid, "3f6f98b4", new Date(t3 + i * (180_000 / 16)).toISOString().replace(/\.\d{3}Z$/, "Z"), bC, "221.0.177.39"));

// ── 用例 H：IP 221.0.177.39 的其他身份（7 身份 / 6 指纹）→ NAT，不作整簇 ──
// 每个身份投 1–2 个互不重叠的填充角色，营造「校园网出口」
const hOther = [
  { id: "h0001", bucket: "b" + "6".repeat(64), pick: FILLER[0] },
  { id: "h0002", bucket: "b" + "7".repeat(64), pick: FILLER[1] },
  { id: "h0003", bucket: "b" + "8".repeat(64), pick: FILLER[2] },
  { id: "h0004", bucket: "b" + "9".repeat(64), pick: FILLER[3] },
  { id: "h0005", bucket: "ba".repeat(32), pick: FILLER[4] },
  { id: "h0006", bucket: "bb".repeat(32), pick: FILLER[5] },
  { id: "h0007", bucket: "bb".repeat(32), pick: FILLER[6] }, // 与 h0006 同指纹但投不同角色
];
hOther.forEach((h, i) => v(h.pick, h.id, new Date(ts("2026-08-16T09:00:00Z") + i * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z"), h.bucket, "221.0.177.39"));

// ── 用例 D：同 IP 跨指纹（现有后台按指纹分组看不到）────────────────────────
v(IDS.lokisi, "87846856", "2026-08-17T14:13:27Z", bD1, "124.129.95.176");
v(IDS.lokisi, "23113372", "2026-08-17T14:14:15Z", bD2, "124.129.95.176"); // 48 秒后、不同指纹

// ── 用例 G：形态混杂的设备（期望 medium）───────────────────────────────────
// 8 身份 / 38 票 / 11 个 IP：既有 4 秒投 3 票的东方三人组，也有跨 8 小时的 13 票票单
const G = ["g001", "g002", "g003", "g004", "g005", "g006", "g007", "g008"];
// g001：4 秒投 3 票（东方三人组）
v(IDS.marisa, "g001", "2026-08-17T08:00:00Z", bG, ipG(1));
v(IDS.reimu, "g001", "2026-08-17T08:00:02Z", bG, ipG(1));
v(IDS.sakuya, "g001", "2026-08-17T08:00:04Z", bG, ipG(1));
// g002：跨 8 小时的 13 票完整票单（含与 g003-g005 重叠的人气角色）
const g2set = [IDS.mikoto, IDS.yukino, IDS.lokisi, IDS.kafuka, IDS.shiroko, IDS.ino, IDS.rikka, IDS.rin, IDS.yuno, IDS.momoka, IDS.chiyoda, IDS.uika, IDS.madoka];
const g2starts = [1, 2, 3, 4, 5, 6, 7, 8, 8.1, 8.2, 8.3, 8.4, 8.5]; // 小时
g2set.forEach((cid, i) => v(cid, "g002", new Date(ts("2026-08-17T01:00:00Z") + g2starts[i] * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z"), bG, ipG(2)));
// g003-g005：5 票、高度重叠的人气角色
const g3 = [IDS.mikoto, IDS.yukino, IDS.shiroko, IDS.ino, IDS.chiyoda];
g3.forEach((cid, i) => v(cid, "g003", new Date(ts("2026-08-17T08:08:00Z") + i * 120_000).toISOString().replace(/\.\d{3}Z$/, "Z"), bG, ipG(3)));
const g4 = [IDS.mikoto, IDS.yukino, IDS.shiroko, IDS.momoka, IDS.madoka];
g4.forEach((cid, i) => v(cid, "g004", new Date(ts("2026-08-17T08:15:00Z") + i * 120_000).toISOString().replace(/\.\d{3}Z$/, "Z"), bG, ipG(4)));
const g5 = [IDS.mikoto, IDS.yukino, IDS.shiroko, IDS.yuno, IDS.uika];
g5.forEach((cid, i) => v(cid, "g005", new Date(ts("2026-08-17T08:20:00Z") + i * 120_000).toISOString().replace(/\.\d{3}Z$/, "Z"), bG, ipG(5)));
// g006-g008：少量票，各 2–3 票
v(IDS.mikoto, "g006", "2026-08-17T09:00:00Z", bG, ipG(6));
v(IDS.yukino, "g006", "2026-08-17T09:02:00Z", bG, ipG(6));
v(IDS.rikka, "g006", "2026-08-17T09:03:00Z", bG, ipG(7));
v(IDS.shiroko, "g007", "2026-08-17T10:00:00Z", bG, ipG(8));
v(IDS.rin, "g007", "2026-08-17T10:01:00Z", bG, ipG(9));
v(IDS.mikoto, "g008", "2026-08-17T11:00:00Z", bG, ipG(10));
v(IDS.rikka, "g008", "2026-08-17T11:01:00Z", bG, ipG(11));

// 落库
const dB: any = {
  seq: { competition: CID, candidate: candSeq, matchup: 0, comment: 0, audit: 0, vote: voteSeq },
  competitions: [{
    id: CID, title: "Fraud Test", description: null, short_name: null, phase: "nomination", target_size: null, groups_count: null,
    champion_id: null, ko_round: null, created_at: ts("2026-08-15T00:00:00Z"), third_place: null, blocked_tags: [], blocked_subjects: [],
    freeze_on: null, freeze_from: null, freeze_to: null, freeze_note: null,
    nom_ends_at: null, group_ends_at: null, ko_round_ends_at: null, auto_size: AUTO, round_hours: null, postpone_days: null,
    nom_user_limit: NOM_MAX, nom_min_votes: 0,
    group_matchday: null, group_matchday_count: null, group_per_round: null, group_round_days: null, group_round_ends_at: null,
    group_day_cap: null, group_size: null, group_mode: null, groups_per_day: null, group_started_at: null, group_matchday_starts: null,
    ko_target: null, ko_seed_ids: null, playoff_slots: null,
  }],
  candidates, matchups: [], nominationVotes, matchVotes: [], approvalVotes: [], comments: [], auditLog: [], sanctions: [], fraudReviewed: [],
};
writeDb(dB);

// ── 跑报告 ───────────────────────────────────────────────────────────────────
const report = fraud.generateFraudReport({ competitionId: CID, phase: "nomination", windowMs: 30 * 60_000, minScore: 20 });
const low = fraud.generateFraudReport({ competitionId: CID, phase: "nomination", windowMs: 30 * 60_000, minScore: 0 });

const clusterContaining = (r: any, ids: string[]) =>
  r.clusters.find((c: any) => ids.every((id) => c.identities.some((i: any) => i.voterId === id)));
const inCluster = (c: any, id: string) => c.identities.some((i: any) => i.voterId === id);
const hasSignal = (c: any, code: string) => c.signals.some((s: any) => s.code === code);

console.log("── 生成的簇 ──");
for (const c of report.clusters) console.log(`  ${c.level}  ${c.score}  ${c.kind}  [${c.identities.map((i: any) => i.voterId).join(", ")}]  ${c.signals.map((s: any) => s.code).join("+")}`);

// ── 用例 A：应判为 high，命中 S1+S2+S5，且不卷入用例 F 的无辜身份 ────────
{
  const a = clusterContaining(report, A);
  check("A: 簇存在", !!a);
  check("A: high 且 ≥70", !!a && a.level === "high" && a.score >= 70);
  check("A: 命中 S1", !!a && hasSignal(a, "S1"));
  check("A: 命中 S2（含网络类型切换加成）", !!a && hasSignal(a, "S2"));
  check("A: 命中 S5（9 票 / 3 角色）", !!a && hasSignal(a, "S5"));
  check("F: 无辜身份不得被卷入 A 的簇", !a || (!inCluster(a, "1b660293") && !inCluster(a, "628b0fe1")));
  check("F: 无辜身份不在任何簇的作废清单里", !clusterContaining(report, ["1b660293"]) && !clusterContaining(report, ["628b0fe1"]));
}

// ── 用例 B / E：重复投票 detected；4aa31ee0 不得出现在 high/medium ──────────
{
  const b = clusterContaining(report, ["64808741", "4aa31ee0"]);
  check("B: 含 64808741 与 4aa31ee0 的簇存在", !!b);
  check("B: 命中 S3（containment）", !!b && hasSignal(b, "S3"));
  const s3 = b?.signals.find((s: any) => s.code === "S3");
  check("B: S3 strength = 1.0（containment=1.0）", !!s3 && s3.strength >= 0.999);
  const highMed = report.clusters.filter((c) => c.level === "high" || c.level === "medium").filter((c) => inCluster(c, "4aa31ee0"));
  check("E: 4aa31ee0 不出现在 high/medium 簇", highMed.length === 0);
  check("E: 4aa31ee0 至多出现在 low 簇", !!b && b.level === "low");
}

// ── 用例 C：顶满上限堆叠，命中 S7+S4+S3 ────────────────────────────────────
{
  const c = clusterContaining(report, ["41ae6c48", "3f6f98b3", "3f6f98b4"]);
  check("C: 簇存在且 high", !!c && c.level === "high" && c.score >= 70);
  check("C: 命中 S7（顶满堆叠）", !!c && hasSignal(c, "S7"));
  check("C: 命中 S4（速率）", !!c && hasSignal(c, "S4"));
  check("C: 命中 S3（票单重叠）", !!c && hasSignal(c, "S3"));
}

// ── 用例 D：同 IP 跨指纹 → 命中 S6（minScore 放宽以显示）───────────────────
{
  const d = clusterContaining(low, ["87846856", "23113372"]);
  check("D: 跨指纹簇存在（S6）", !!d);
  check("D: 命中 S6", !!d && hasSignal(d, "S6"));
}

// ── 用例 G：形态混杂 → medium ───────────────────────────────────────────────
// 桶内 8 身份中，东方三人组（g001）不与其它身份共票、是独立孤点；其余 7 个共票身份聚成一个 medium 簇。
{
  const g = report.clusters.find((c: any) => c.level === "medium" && c.identities.filter((i: any) => G.includes(i.voterId)).length >= 6);
  check("G: 存在含 ≥6 个 G 身份的 medium 簇", !!g);
  check("G: medium（40–69）", !!g && g.score >= 40 && g.score < 70);
  check("G: 东方三人组孤点（g001）未被误判为 high", !report.clusters.some((c: any) => c.level === "high" && c.identities.some((i: any) => i.voterId === "g001")));
}

// ── 用例 H：NAT IP 标记 suspectedNAT，且其中用例 C 仍独立命中 ───────────────
{
  const nat = report.natSuspects.find((n) => n.ipNorm === "221.0.177.39");
  check("H: 221.0.177.39 标记为 suspectedNAT（10 身份 / 7 指纹）", !!nat && nat.identities >= 10 && nat.buckets === 7);
  const c = clusterContaining(report, ["41ae6c48", "3f6f98b3", "3f6f98b4"]);
  check("H: 其中的用例 C 仍独立命中 high", !!c && c.level === "high");
}

// ── 影响量化：作废 A 簇的票，会改变相关角色的票数 ──────────────────────────
{
  const a = clusterContaining(report, A);
  const voterIds = A; // c948e791 等
  const impact = fraud.computeImpact(CID, voterIds);
  const lokisi = impact.affected.find((x: any) => x.candidateId === IDS.lokisi);
  check("Impact: 洛琪希票数随 A 簇作废而减少", !!lokisi && lokisi.votesBefore > lokisi.votesAfter);
  check("Impact: 切线存在（cutLine>0）", impact.cutLine > 0);
  check("Impact: 存在与切线同票的平票人数", impact.tiedAtCutLine >= 1);
}

// ── 幂等性：同一份数据两次报告结果一致 ─────────────────────────────────────
{
  const r2 = fraud.generateFraudReport({ competitionId: CID, phase: "nomination", windowMs: 30 * 60_000, minScore: 20 });
  check("幂等: 两次报告簇数一致", r2.clusters.length === report.clusters.length);
  check("幂等: 各簇分数一致", r2.clusters.every((c: any, i: number) => c.score === report.clusters[i].score && c.id === report.clusters[i].id));
}

// ── 白名单：标记已复核后簇带 reviewed 标记 ─────────────────────────────────
{
  const a = clusterContaining(report, A);
  fraud.setReviewed([a.id], true);
  const r2 = fraud.generateFraudReport({ competitionId: CID, phase: "nomination", windowMs: 30 * 60_000, minScore: 20 });
  check("白名单: 已复核簇带 reviewed 标记", r2.clusters.find((c: any) => c.id === a.id)?.reviewed === true);
  fraud.setReviewed([a.id], false); // 复位，避免影响其它断言
}

// ── normalizeIp / ip64 分组与作废（db.ts 新增能力）─────────────────────────
{
  check("normalizeIp: IPv6 归一为 /64", ip.normalizeIp("2408:8214:d11:7751:5db1:1:2:3") === "2408:8214:d11:7751::/64");
  check("normalizeIp: IPv4 原样", ip.normalizeIp("124.129.95.176") === "124.129.95.176");
  check("normalizeIp: IPv4-mapped IPv6 剥壳", ip.normalizeIp("::ffff:124.129.95.176") === "124.129.95.176");
  check("normalizeIp: 空值返回 null", ip.normalizeIp(null) === null && ip.normalizeIp("") === null);

  // 用例 A 的 IPv6 票（不同后缀、同一 /64）能按 /64 前缀一次性列出，且不含同桶的 IPv4 票
  const ip64 = "2408:8418:d20:aaaa::/64";
  const rows = db.listVotesBy(CID, "ip64", ip64);
  check("ip64: 按 /64 前缀跨后缀列出票", rows.length >= 5 && rows.some((r) => r.voterId === "c948e791") && rows.some((r) => r.voterId === "d64f2ca8"));
  check("ip64: 不含 IPv4 的票（112.224.195.158）", !rows.some((r) => r.ip === "112.224.195.158"));
}

// ── ip64 作废：只删匹配 /64 前缀的票，IPv4 不受影响（用独立小比赛验证）─────
{
  const C3 = 3;
  const d3 = db.readDb(); // 取最新快照再改，避免触发并发写保护
  d3.competitions.push({ ...d3.competitions[0], id: C3, auto_size: 8, nom_user_limit: 16 });
  d3.candidates.push({ id: 500, competition_id: C3, bgm_id: "x", name: "X", name_cn: "X", image: null, group_no: null, seed: null, eliminated: false, subject_name: null, added_by: null, name_en: null, aliases: [], parent_id: null });
  d3.nominationVotes.push(
    { id: 9001, competition_id: C3, candidate_id: 500, voter_id: "v6a", created_at: ts("2026-08-17T09:00:00Z"), device_bucket: "b1", ip: "2408:aaaa:bbbb:cccc:1:1:1:1" },
    { id: 9002, competition_id: C3, candidate_id: 500, voter_id: "v6b", created_at: ts("2026-08-17T09:01:00Z"), device_bucket: "b2", ip: "2408:aaaa:bbbb:cccc:2:2:2:2" }, // 同 /64、不同后缀
    { id: 9003, competition_id: C3, candidate_id: 500, voter_id: "v4a", created_at: ts("2026-08-17T09:02:00Z"), device_bucket: "b3", ip: "203.0.113.99" },
  );
  writeDb(d3);
  const n = db.invalidateVotes(C3, "ip64", "2408:aaaa:bbbb:cccc::/64");
  check("ip64: 作废只删同 /64 的 2 票", n === 2);
  check("ip64: 作废后同 /64 下无票", db.listVotesBy(C3, "ip64", "2408:aaaa:bbbb:cccc::/64").length === 0);
  check("ip64: IPv4 票不受影响", db.listVotesBy(C3, "ip64", "203.0.113.99").length === 1);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall fraud checks passed");
process.exit(failures ? 1 : 0);
