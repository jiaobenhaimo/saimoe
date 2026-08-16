import { NextRequest, NextResponse } from "next/server";
import { apiEnabled } from "@/lib/flags";
import { rateLimited } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bangumi 代理。浏览器直连 api.bgm.tv 在部分网络下很慢甚至连不上(跨域被拦、丢包),
// 前端会「直连 + 走这里」两条通道赛跑，取先返回的那条。服务端（东京）到 Bangumi 通常
// 更快更稳，于是慢网络的用户也能搜出结果。
// 只读、只转发白名单端点，并做短时缓存 + 限流，避免被当成刷接口的跳板。

const UA = "saimoe/1.0 (+https://github.com/jiaobenhaimo/saimoe)";
const TTL = 5 * 60_000;
const cache = new Map<string, { at: number; body: any }>();

function cached(key: string): any | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL) { cache.delete(key); return null; }
  return hit.body;
}
function put(key: string, body: any): void {
  if (cache.size > 500) for (const k of [...cache.keys()].slice(0, 200)) cache.delete(k);
  cache.set(key, { at: Date.now(), body });
}

async function up(url: string, init: RequestInit = {}, ms = 8_000): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal, headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) }, cache: "no-store" });
    if (!r.ok) throw new Error("upstream " + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

export async function GET(req: NextRequest) {
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "unknown";
  if (rateLimited("bgm:" + ip, 120, 60_000)) return NextResponse.json({ error: "请求过于频繁，请稍后再试。" }, { status: 429 });

  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind") || "";
  const q = (sp.get("q") || "").trim();
  const id = (sp.get("id") || "").trim();
  const key = `${kind}|${q}|${id}`;
  const hit = cached(key);
  if (hit) return NextResponse.json(hit);

  try {
    let body: any;
    if (kind === "chars") {
      if (!q) return NextResponse.json({ error: "缺少关键词。" }, { status: 400 });
      body = await up("https://api.bgm.tv/v0/search/characters?limit=20", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyword: q }),
      });
    } else if (kind === "subjects") {
      if (!q) return NextResponse.json({ error: "缺少关键词。" }, { status: 400 });
      body = await up(`https://api.bgm.tv/search/subject/${encodeURIComponent(q)}?type=2&responseGroup=large&max_results=20`);
    } else if (kind === "subjectChars") {
      if (!/^\d+$/.test(id)) return NextResponse.json({ error: "无效 id。" }, { status: 400 });
      body = await up(`https://api.bgm.tv/v0/subjects/${id}/characters`);
    } else if (kind === "charDetail") {
      if (!/^\d+$/.test(id)) return NextResponse.json({ error: "无效 id。" }, { status: 400 });
      body = await up(`https://api.bgm.tv/v0/characters/${id}`);
    } else if (kind === "subject") {
      if (!/^\d+$/.test(id)) return NextResponse.json({ error: "无效 id。" }, { status: 400 });
      body = await up(`https://api.bgm.tv/v0/subjects/${id}`);
    } else if (kind === "charSubjects") {
      if (!/^\d+$/.test(id)) return NextResponse.json({ error: "无效 id。" }, { status: 400 });
      body = await up(`https://api.bgm.tv/v0/characters/${id}/subjects`);
    } else {
      return NextResponse.json({ error: "未知的 kind。" }, { status: 400 });
    }
    put(key, body);
    return NextResponse.json(body);
  } catch (e: any) {
    return NextResponse.json({ error: "上游请求失败：" + (e?.message || "unknown") }, { status: 502 });
  }
}
