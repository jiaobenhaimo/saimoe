import { NextRequest, NextResponse } from "next/server";
import { apiEnabled } from "@/lib/flags";
import { rateLimited } from "@/lib/ratelimit";
import { clientIp } from "@/lib/ip";
import { searchCharacters, searchSubjects, subjectCharacters, characterDetail, jpBatch, jpOfSubject, jpOfCharacter, rawLegacy } from "@/lib/bgm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bangumi gateway. Two generations of endpoints live here.
 *
 *  RESOLVED (preferred, added when the work moved server-side): `searchChars`, `searchSubjects`,
 *  `resolveSubject`, `resolveChar`. These return exactly the fields the app stores -- Chinese and
 *  English names already filled in, origin check already applied. One browser request replaces
 *  the dozens the client used to make.
 *
 *  LEGACY (kept deliberately): `chars`, `subjects`, `subjectChars`, `charDetail`, `subject`,
 *  `charSubjects`, `jpbatch`. A tab loaded before this deploy is still running the old client
 *  code; dropping these would break voters mid-round until they reload. They are thin wrappers.
 *
 * Caching, upstream concurrency limiting and request de-duplication all live in lib/bgm.
 */
export async function GET(req: NextRequest) {
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });

  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind") || "";
  const q = (sp.get("q") || "").trim();
  const id = (sp.get("id") || "").trim();
  const numeric = /^\d+$/;

  // Resolved endpoints fan out to many upstream calls, so they get a tighter budget than the
  // legacy ones (one upstream call each).
  const heavy = kind === "resolveSubject" || kind === "searchChars" || kind === "resolveChar";
  if (rateLimited("bgm:" + clientIp(req.headers), heavy ? 40 : 120, 60_000))
    return NextResponse.json({ error: "请求过于频繁，请稍后再试。" }, { status: 429 });

  try {
    switch (kind) {
      // ── resolved endpoints ──────────────────────────────────────────────
      case "searchChars": {
        if (!q) return NextResponse.json({ error: "缺少关键词。" }, { status: 400 });
        const hits = await searchCharacters(q);
        // Origin check server-side: characters whose works definitively lack the 日本 tag are
        // hidden from the picker. An INCONCLUSIVE result is kept -- a Bangumi hiccup must not
        // silently empty the search results.
        const verdicts = await jpBatch(hits.map((h) => h.bgmId.slice(1)));
        const keep = hits.filter((h) => verdicts[h.bgmId.slice(1)] !== false);
        return NextResponse.json({ hits: keep, filtered: hits.length - keep.length });
      }
      case "searchSubjects": {
        if (!q) return NextResponse.json({ error: "缺少关键词。" }, { status: 400 });
        return NextResponse.json({ hits: await searchSubjects(q) });
      }
      case "resolveSubject": {
        if (!numeric.test(id)) return NextResponse.json({ error: "无效 id。" }, { status: 400 });
        const [chars, jp] = await Promise.all([subjectCharacters(id), jpOfSubject(id)]);
        return NextResponse.json({ chars, jp: jp.ok, jpReason: jp.reason });
      }
      case "resolveChar": {
        if (!numeric.test(id)) return NextResponse.json({ error: "无效 id。" }, { status: 400 });
        const [info, jp] = await Promise.all([characterDetail(id), jpOfCharacter(id)]);
        if (!info) return NextResponse.json({ error: "角色不存在或上游不可达。" }, { status: 502 });
        return NextResponse.json({ char: info, jp: jp.ok, jpReason: jp.reason });
      }

      // ── legacy shapes, for browser tabs loaded before this deploy ───────
      case "chars": {
        if (!q) return NextResponse.json({ error: "缺少关键词。" }, { status: 400 });
        const hits = await searchCharacters(q);
        return NextResponse.json({ data: hits.map((h) => ({ id: Number(h.bgmId.slice(1)), name: h.name, type: 1, images: { grid: h.image } })) });
      }
      case "subjects": {
        if (!q) return NextResponse.json({ error: "缺少关键词。" }, { status: 400 });
        const hits = await searchSubjects(q);
        return NextResponse.json({ list: hits.map((h) => ({ id: Number(h.subjectId), name: h.name, name_cn: h.nameCn, images: { grid: h.image }, air_date: h.year, tags: h.tags.map((t) => ({ name: t })) })) });
      }
      case "subjectChars":
      case "charDetail":
      case "subject":
      case "charSubjects": {
        if (!numeric.test(id)) return NextResponse.json({ error: "无效 id。" }, { status: 400 });
        return NextResponse.json(await rawLegacy(kind, id));
      }
      case "jpbatch": {
        const ids = (sp.get("ids") || "").split(",").map((x) => x.trim().replace(/^c/, "")).filter((x) => numeric.test(x));
        const jp = await jpBatch(ids);
        // Legacy callers expect booleans and treat false as "hide". Report "couldn't tell" as
        // true so an upstream failure never filters a legitimate character out.
        const out: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(jp)) out[k] = v !== false;
        return NextResponse.json({ jp: out });
      }
      default:
        return NextResponse.json({ error: "未知的 kind。" }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: "上游请求失败：" + (e?.message || "unknown") }, { status: 502 });
  }
}
