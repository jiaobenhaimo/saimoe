import { NextRequest, NextResponse } from "next/server";
import { adminOk } from "@/lib/adminauth";
import { ensureSchema, readAudit, listJpFlagged, readDbRO } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getActiveCompetition } from "@/lib/engine";
import { detectAnomalies, projectTimeline, liveTallies, dataGaps } from "@/lib/observe";
import { preflight } from "@/lib/preflight";
import { listRoundArchives, backupEnabled } from "@/lib/backup";
import { listVotesBy, planSmartInvalidate } from "@/lib/db";
import { normalizeIp } from "@/lib/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const token = req.headers.get("x-admin-token");
  return adminOk(token);
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });
  ensureSchema();
  const comp = getActiveCompetition();
  const audit = readAudit(200);
  if (!comp) return NextResponse.json({ competition: null, flags: [], thresholds: {}, totals: { votes: 0, matches: 0, withMeta: 0 }, timeline: [], audit, jpFlagged: [] });
  // 可疑票溯源：带 by/key 时只回这个身份的逐票明细，供运营点开查看。
  // ip64=1 时把 key 按 /64 归一化匹配（同一宽带 IPv6 后缀频繁变化，/64 前缀才是稳定身份）。
  const by = req.nextUrl.searchParams.get("by");
  const key = req.nextUrl.searchParams.get("key");
  const ip64 = req.nextUrl.searchParams.get("ip64") === "1" || by === "ip64";
  if (by && key && (by === "bucket" || by === "ip" || by === "voter" || by === "ip64")) {
    const effBy = ip64 ? "ip64" : by;
    const effKey = ip64 ? (normalizeIp(key) || key) : key;
    if (req.nextUrl.searchParams.get("mode") === "smart")
      return NextResponse.json({ plan: planSmartInvalidate(comp.id, effBy as "bucket" | "ip" | "voter" | "ip64", effKey), by: effBy, key: effKey, ip64 });
    return NextResponse.json({ votes: listVotesBy(comp.id, effBy as "bucket" | "ip" | "voter" | "ip64", effKey), by: effBy, key: effKey, ip64 });
  }

  const { flags, thresholds, totals } = detectAnomalies(comp.id);
  const timeline = projectTimeline(comp.id);
  const tallies = liveTallies(comp.id);
  const gaps = dataGaps(comp.id);
  // 日本产地复核队列：提名时明确没查到「日本」标签的角色（用户已被告知"管理员会复核"）
  const jpFlagged = listJpFlagged(comp.id);
  // 开赛前检查：把「现在开小组赛会不会翻车」的所有条件集中给运营看（见 lib/preflight.ts）
  const pre = preflight(comp.id);
  // 角色名册：管理台在任何阶段都需要它 —— 「管理提名池」只在提名阶段出现，但资料填错
  // 往往是开赛后才发现的，那时替换角色是唯一安全的改法（删掉重加会连票和分组一起丢）。
  // 已淘汰的角色默认不给（前端可以选择显示），理由同 dataGaps。
  const roster = readDbRO().candidates
    .filter((c) => c.competition_id === comp.id)
    .map((c) => ({ id: c.id, bgmId: c.bgm_id, name: c.name, nameCn: c.name_cn, image: c.image,
      subjectName: c.subject_name ?? null, groupNo: c.group_no, seed: c.seed, eliminated: !!c.eliminated }))
    .sort((a, b) => (a.groupNo ?? 999) - (b.groupNo ?? 999) || (a.seed ?? 0) - (b.seed ?? 0) || a.id - b.id);
  const archives = listRoundArchives().slice(0, 40);
  return NextResponse.json({ competition: { id: comp.id, phase: comp.phase }, flags, thresholds, totals, timeline, tallies, gaps, audit, jpFlagged, preflight: pre, roster, archives, backupOn: backupEnabled() });
}
