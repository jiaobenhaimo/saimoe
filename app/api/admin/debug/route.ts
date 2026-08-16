import { NextRequest, NextResponse } from "next/server";
import { adminOk } from "@/lib/adminauth";
import { ensureSchema } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { debugSeed, debugNominate, debugVote, debugSimulate } from "@/lib/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const token = req.headers.get("x-admin-token");
  return adminOk(token);
}
function debugOn(): boolean {
  return process.env.DEBUG_MODE === "true";
}

// GET → let the (authenticated) admin UI know whether the debug panel should show.
export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });
  return NextResponse.json({ enabled: debugOn() });
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });
  if (!debugOn()) return NextResponse.json({ error: "调试模式未开启。请设置环境变量 DEBUG_MODE=true 后重新部署。" }, { status: 403 });
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。" }, { status: 503 });
  try {
    ensureSchema();
    const body = await req.json();
    const action = String(body.action || "");
    if (action === "seed") return NextResponse.json({ ok: true, ...debugSeed(Number(body.count) || 16) });
    if (action === "nominate") return NextResponse.json({ ok: true, ...debugNominate(Number(body.votes) || 200) });
    if (action === "vote") return NextResponse.json({ ok: true, ...debugVote(Number(body.voters) || 40) });
    if (action === "simulate")
      return NextResponse.json({ ok: true, ...debugSimulate({ count: Number(body.count) || 8, groups: Number(body.groups) || 2, advance: Number(body.advance) || 2, perRound: Number(body.perRound) || 0, voters: Number(body.voters) || 30 }) });
    return NextResponse.json({ error: "未知调试操作。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "debug failed" }, { status: 400 });
  }
}
