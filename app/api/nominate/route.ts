import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, addCandidate, removeOwnCandidate, sweepOwnOrphans } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getActiveCompetition } from "@/lib/engine";
import { getVoterId } from "@/lib/voter";
import { getSid } from "@/lib/sid";
import { rateLimited } from "@/lib/ratelimit";
import { gateOn, verifyToken, VOTER_COOKIE } from "@/lib/wxsession";

function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "unknown";
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
    // per-IP nominate cap is a coarse abuse guard; loosen it a lot when the WeChat gate is
    // off (no strong identity, and legit voters share IPs behind NAT).
    if (rateLimited("nominate:" + clientIp(req), gateOn() ? 30 : 200, 60_000))
      return NextResponse.json({ error: "操作太频繁，请稍后再试。" }, { status: 429 });
    // per-identity cap on the unforgeable sid (rotating x-fp can't reset it)
    if (rateLimited("nomv:" + (await getSid()), gateOn() ? 30 : 120, 60_000))
      return NextResponse.json({ error: "提名太频繁，请稍后再试。" }, { status: 429 });
    ensureSchema();
    const comp = getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "还没有进行中的比赛。" }, { status: 400 });
    if (comp.phase !== "nomination") return NextResponse.json({ error: "提名阶段已结束。" }, { status: 400 });

    const vid = await getVoterId();
    // WeChat gate: when on, only users arriving via a per-user 公众号 link may modify the pool.
    if (gateOn() && !verifyToken(req.cookies.get(VOTER_COOKIE)?.value))
      return NextResponse.json({ error: "请在公众号回复「投票」获取链接后再提名。", needLink: true }, { status: 403 });
    const body = await req.json();

    // ── page-close beacon: drop the caller's own un-voted (0-vote) self-nominations ──
    if (body.sweep === true) {
      if (comp.phase !== "nomination") return NextResponse.json({ ok: true, removed: 0 });
      return NextResponse.json({ ok: true, removed: sweepOwnOrphans(comp.id, vid) });
    }

    // ── remove a character the current user nominated (only if it has 0 votes) ──
    if (body.remove != null) {
      const r = removeOwnCandidate(comp.id, Number(body.remove), vid);
      if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
      return NextResponse.json({ ok: true });
    }

    // ── client-resolved batch: store pre-fetched candidates (browser did the Bangumi GET; server never touches Bangumi) ──
    if (Array.isArray(body.batch)) {
      let added = 0;
      for (const c of body.batch.slice(0, 200)) {
        const name = String(c?.name || "").trim();
        if (!name) continue;
        const bgmId = String(c?.bgmId || "m_" + Math.random().toString(36).slice(2, 8));
        const nameCn = String(c?.nameCn || "").trim();
        const image = String(c?.image || "").trim();
        const subjectName = String(c?.subjectName || "").trim();
        const nameEn = String(c?.nameEn || "").trim();
        if (addCandidate(comp.id, bgmId, name, nameCn, image, subjectName, vid, nameEn)) added++;
      }
      return NextResponse.json({ ok: true, added, imported: body.batch.length });
    }

    return NextResponse.json({ error: "缺少角色信息。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "nominate failed" }, { status: 500 });
  }
}
