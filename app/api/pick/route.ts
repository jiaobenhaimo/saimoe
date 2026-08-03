import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, setPick, setPickName } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getVoterId } from "@/lib/voter";
import { getActiveCompetition } from "@/lib/engine";
import { rateLimited } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "unknown";
}

// Pick'em: POST { matchupId, pickId | null } to set/change/clear a prediction on an
// open match, or { name } to update the leaderboard display name.
export async function POST(req: NextRequest) {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
    if (rateLimited("pick:" + clientIp(req), 120, 60_000))
      return NextResponse.json({ error: "操作太频繁，请稍后再试。" }, { status: 429 });
    ensureSchema();
    const vid = await getVoterId();
    const body = await req.json();
    const comp = getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "没有进行中的比赛。" }, { status: 400 });

    if (typeof body.name === "string") setPickName(vid, body.name);
    if (body.matchupId !== undefined) {
      const matchupId = Number(body.matchupId);
      const pickId = body.pickId == null ? null : Number(body.pickId);
      const r = setPick(comp.id, matchupId, vid, pickId);
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json({ ok: true, pick: r.pick });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "pick failed" }, { status: 500 });
  }
}
