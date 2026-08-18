import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, addComment, listComments } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getVoterId } from "@/lib/voter";
import { getActiveCompetition } from "@/lib/engine";
import { rateLimited } from "@/lib/ratelimit";
import { gateOn } from "@/lib/wxsession";
import { clientIp } from "@/lib/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export async function GET(req: NextRequest) {
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });
  ensureSchema();
  const comp = getActiveCompetition();
  if (!comp) return NextResponse.json({ comments: [] });
  const matchupId = Number(req.nextUrl.searchParams.get("matchupId")) || 0;
  return NextResponse.json({ comments: listComments(comp.id, matchupId) });
}

export async function POST(req: NextRequest) {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });
    ensureSchema();
    const vid = await getVoterId();
    const ip = clientIp(req.headers);
    // 反刷：每个身份每分钟最多 10 条；IP 上限仅作粗粒度防滥用，门禁关闭时放宽（NAT 共享）
    if (rateLimited("cmt:" + vid, 10, 60_000) || rateLimited("cmtip:" + ip, gateOn() ? 20 : 120, 60_000))
      return NextResponse.json({ error: "评论太频繁，请稍后再试。" }, { status: 429 });
    const comp = getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "没有进行中的比赛。" }, { status: 400 });
    const body = await req.json();
    const r = addComment(comp.id, Number(body.matchupId) || 0, vid, String(body.name || ""), String(body.text || ""));
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, comment: r.comment });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "comment failed" }, { status: 500 });
  }
}
