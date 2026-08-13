import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, toggleNomination, castMatchVote, castApprovalVote } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getVoterId, getDeviceBucket } from "@/lib/voter";
import { getActiveCompetition } from "@/lib/engine";
import { rateLimited } from "@/lib/ratelimit";
import { verifyToken, gateOn, VOTER_COOKIE } from "@/lib/wxsession";

function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "unknown";
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
    ensureSchema();
    const vid = await getVoterId();
    const bucket = await getDeviceBucket();
    const ip = clientIp(req);
    const meta = { bucket, ip };

    // WeChat gate (admin-toggleable): only users who opened a per-user link from the 公众号
    // may vote; direct site visitors are read-only. openid becomes the dedup identity.
    let voterId = vid;
    const strict = gateOn();
    if (strict) {
      const openid = verifyToken(req.cookies.get(VOTER_COOKIE)?.value);
      if (!openid) return NextResponse.json({ error: "请在公众号回复「投票」获取投票链接后再来投票。", needLink: true }, { status: 403 });
      voterId = "wx:" + openid;
    }

    // Rate limiting. Always cap per-identity (fingerprint/openid). The per-IP cap is only a
    // coarse abuse guard; when the WeChat gate is OFF there's no strong identity and many
    // legitimate voters share one IP (campus/dorm NAT), so we loosen the IP cap a lot.
    if (rateLimited("votev:" + voterId, 60, 60_000))
      return NextResponse.json({ error: "投票太频繁，请稍后再试。" }, { status: 429 });
    if (rateLimited("vote:" + ip, strict ? 120 : 1000, 60_000))
      return NextResponse.json({ error: "该网络投票过于密集，请稍后再试。" }, { status: 429 });

    const comp = getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "没有进行中的比赛。" }, { status: 400 });

    const body = await req.json();

    // ── nomination upvote (toggle) ──
    if (body.type === "nominate") {
      if (comp.phase !== "nomination") return NextResponse.json({ error: "提名投票已结束。" }, { status: 400 });
      const r = toggleNomination(comp.id, Number(body.candidateId), voterId, meta);
      if (!r) return NextResponse.json({ error: "角色不存在。" }, { status: 404 });
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
      return NextResponse.json({ ok: true, voted: r.voted });
    }

    // ── group approval vote (approval mode: ≤2 picks per group) ──
    if (body.type === "approval") {
      if (comp.phase !== "group") return NextResponse.json({ error: "当前不在小组赛阶段。" }, { status: 400 });
      const r = castApprovalVote(comp.id, Number(body.candidateId), voterId, meta);
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json({ ok: true, picked: r.picked, count: r.count });
    }

    // ── matchup vote (group or knockout) ──
    if (body.type === "match") {
      if (comp.phase !== "group" && comp.phase !== "knockout" && comp.phase !== "playoff") return NextResponse.json({ error: "当前没有开放的对战。" }, { status: 400 });
      const r = castMatchVote(comp.id, Number(body.matchupId), voterId, Number(body.choiceId), meta);
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json({ ok: true, choice: r.choice });
    }

    return NextResponse.json({ error: "未知投票类型。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "vote failed" }, { status: 500 });
  }
}
