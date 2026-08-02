import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getVoterId } from "@/lib/voter";
import { getState } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
    ensureSchema();
    const vid = await getVoterId();
    return NextResponse.json(getState(vid));
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "server error" }, { status: 500 });
  }
}
