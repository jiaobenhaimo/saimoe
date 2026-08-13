import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getVoterId } from "@/lib/voter";
import { getState } from "@/lib/engine";
import { runTick } from "@/lib/schedule";
import { verifyToken, gateOn, VOTER_COOKIE } from "@/lib/wxsession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
    ensureSchema();
    runTick();
    const vid = await getVoterId();
    const on = gateOn();
    const canVote = !on || !!verifyToken(req.cookies.get(VOTER_COOKIE)?.value);
    return NextResponse.json({ ...getState(vid), voteGate: { on, canVote } });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "server error" }, { status: 500 });
  }
}
