import { NextRequest, NextResponse } from "next/server";
import { adminOk } from "@/lib/adminauth";
import { ensureSchema, readAudit } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getActiveCompetition } from "@/lib/engine";
import { detectAnomalies, projectTimeline, liveTallies } from "@/lib/observe";

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
  if (!comp) return NextResponse.json({ competition: null, flags: [], thresholds: {}, totals: { votes: 0, matches: 0, withMeta: 0 }, timeline: [], audit });
  const { flags, thresholds, totals } = detectAnomalies(comp.id);
  const timeline = projectTimeline(comp.id);
  const tallies = liveTallies(comp.id);
  return NextResponse.json({ competition: { id: comp.id, phase: comp.phase }, flags, thresholds, totals, timeline, tallies, audit });
}
