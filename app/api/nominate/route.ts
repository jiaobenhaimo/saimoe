import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, addCandidate, removeOwnCandidate } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getActiveCompetition } from "@/lib/engine";
import { getVoterId } from "@/lib/voter";
import { getCharacter, getSubjectCharacters, parseSubjectId, type BgmHit } from "@/lib/bangumi";
import { rateLimited } from "@/lib/ratelimit";

function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "unknown";
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
    if (rateLimited("nominate:" + clientIp(req), 30, 60_000))
      return NextResponse.json({ error: "操作太频繁，请稍后再试。" }, { status: 429 });
    ensureSchema();
    const comp = getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "还没有进行中的比赛。" }, { status: 400 });
    if (comp.phase !== "nomination") return NextResponse.json({ error: "提名阶段已结束。" }, { status: 400 });

    const vid = await getVoterId();
    const body = await req.json();

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
        if (addCandidate(comp.id, bgmId, name, nameCn, image, subjectName, vid)) added++;
      }
      return NextResponse.json({ ok: true, added, imported: body.batch.length });
    }

    // ── batch: import a whole subject's cast ──
    if (body.subject) {
      const sid = parseSubjectId(String(body.subject));
      if (!sid) return NextResponse.json({ error: "无法识别作品 ID / 链接。" }, { status: 400 });
      const cast: BgmHit[] = await getSubjectCharacters(sid);
      let added = 0;
      for (const c of cast) if (addCandidate(comp.id, c.bgmId, c.name, "", c.image)) added++;
      return NextResponse.json({ ok: true, imported: cast.length, added });
    }

    // ── single from Bangumi id ──
    if (body.bgmId) {
      const d = await getCharacter(String(body.bgmId));
      return NextResponse.json({ ok: true, added: addCandidate(comp.id, d.bgmId, d.name, d.nameCn, d.image) });
    }

    // ── manual add ──
    if (body.manual?.name) {
      const name = String(body.manual.name).trim();
      const nameCn = String(body.manual.nameCn || "").trim();
      const image = String(body.manual.image || "").trim();
      const bgmId = "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      return NextResponse.json({ ok: true, added: addCandidate(comp.id, bgmId, name, nameCn, image, "", vid) });
    }

    return NextResponse.json({ error: "缺少角色信息。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "nominate failed" }, { status: 500 });
  }
}
