import { NextRequest, NextResponse } from "next/server";
import { adminOk } from "@/lib/adminauth";
import { ensureSchema, logAudit, readDbRO } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { computeImpact, generateFraudReport, setReviewed } from "@/lib/fraud";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const token = req.headers.get("x-admin-token");
  return adminOk(token);
}

/**
 * GET /api/admin/fraud-report?competition_id=2&phase=nomination&window=30&minScore=20&voterIds=...
 * 生成异常投票检测报告（只读）。可选 voterIds（逗号分隔）返回「这些身份全部作废」的合并影响预览。
 *
 * POST { action: "mark_reviewed" | "unmark_reviewed", ids: string[] }
 * 把簇标记为已复核（误报）或取消标记，后续报告中折叠显示。
 */
export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });
  ensureSchema();
  const sp = req.nextUrl.searchParams;
  const phaseRaw = sp.get("phase");
  const phase = phaseRaw === "approval" || phaseRaw === "match" ? phaseRaw : "nomination";
  const windowMin = Math.max(1, Number(sp.get("window")) || 30);
  const minScore = Number(sp.get("minScore"));
  const cid = Number(sp.get("competition_id"));
  const voterIds = (sp.get("voterIds") || "").split(",").map((s) => s.trim()).filter(Boolean);
  // 轻量模式：只要「当前勾选组合」的合并影响预览，不重新跑整份报告
  if (sp.get("impactOnly") === "1" && voterIds.length) {
    const comps = readDbRO().competitions;
    const resolvedCid = cid || (comps.length ? Math.max(...comps.map((c) => c.id)) : 0);
    // phase 必须一起传：不同阶段作废影响的是不同东西（提名排名 / 小组出线 / 单场胜负），
    // 少传就会回到「只算提名排名」的旧行为，在小组赛期间给出一份看起来无害的假预览。
    if (resolvedCid) return NextResponse.json({ combinedImpact: computeImpact(resolvedCid, voterIds, phase) });
  }
  const report = generateFraudReport({
    competitionId: cid || undefined,
    phase,
    windowMs: windowMin * 60_000,
    minScore: Number.isFinite(minScore) && minScore >= 0 ? minScore : 20,
    voterIds: voterIds.length ? voterIds : undefined,
  });
  return NextResponse.json(report);
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });
  try {
    const body = await req.json();
    const action = body.action;
    if (action === "mark_reviewed" || action === "unmark_reviewed") {
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      setReviewed(ids, action === "mark_reviewed");
      if (ids.length)
        logAudit(action, `异常投票：${action === "mark_reviewed" ? "标记为已复核（误报）" : "取消已复核"} ${ids.length} 个簇`, null);
      return NextResponse.json({ ok: true, count: ids.length });
    }
    return NextResponse.json({ error: "未知操作。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "操作失败" }, { status: 400 });
  }
}
