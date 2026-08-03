import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, toggleNomination, castMatchVote } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getVoterId } from "@/lib/voter";
import { getActiveCompetition } from "@/lib/engine";
import { rateLimited } from "@/lib/ratelimit";

function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "unknown";
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
    if (rateLimited("vote:" + clientIp(req), 120, 60_000))
      return NextResponse.json({ error: "投票太频繁，请稍后再试。" }, { status: 429 });
    ensureSchema();
    const vid = await getVoterId();
    const comp = getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "没有进行中的比赛。" }, { status: 400 });

    const body = await req.json();

    // ── nomination upvote (toggle) ──
    if (body.type === "nominate") {
      if (comp.phase !== "nomination") return NextResponse.json({ error: "提名投票已结束。" }, { status: 400 });
      const r = toggleNomination(comp.id, Number(body.candidateId), vid);
      if (!r) return NextResponse.json({ error: "角色不存在。" }, { status: 404 });
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
      return NextResponse.json({ ok: true, voted: r.voted });
    }

    // ── matchup vote (group or knockout) ──
    if (body.type === "match") {
      if (comp.phase !== "group" && comp.phase !== "knockout" && comp.phase !== "playoff") return NextResponse.json({ error: "当前没有开放的对战。" }, { status: 400 });
      const r = castMatchVote(comp.id, Number(body.matchupId), vid, Number(body.choiceId));
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json({ ok: true, choice: r.choice });
    }

    return NextResponse.json({ error: "未知投票类型。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "vote failed" }, { status: 500 });
  }
}
