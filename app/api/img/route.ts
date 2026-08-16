import { NextRequest, NextResponse } from "next/server";
import { apiEnabled } from "@/lib/flags";
import { rateLimited } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 图片代理（item4）。浏览器直连 Bangumi 图床失败时的兜底：
//  ① 老接口返回 http:// 链接，HTTPS 站点会按混合内容拦掉（前端已统一升 https）；
//  ② 部分网络访问不到 lain.bgm.tv；
//  ③ 图床防盗链。
// 只允许 Bangumi 自家域名，避免变成任意图片的开放代理。
const ALLOW = /^(?:[a-z0-9-]+\.)*(?:bgm\.tv|bangumi\.tv)$/i;

export async function GET(req: NextRequest) {
  if (!apiEnabled()) return new NextResponse("disabled", { status: 503 });
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "unknown";
  if (rateLimited("img:" + ip, 600, 60_000)) return new NextResponse("too many requests", { status: 429 });

  const raw = req.nextUrl.searchParams.get("u") || "";
  let target: URL;
  try { target = new URL(raw); } catch { return new NextResponse("bad url", { status: 400 }); }
  if (target.protocol !== "https:" && target.protocol !== "http:") return new NextResponse("bad scheme", { status: 400 });
  if (!ALLOW.test(target.hostname)) return new NextResponse("host not allowed", { status: 403 });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8_000);
  try {
    const r = await fetch(target.toString(), {
      signal: ac.signal,
      // 不带 Referer，绕开图床防盗链
      headers: { "User-Agent": "saimoe/1.0 (+https://github.com/jiaobenhaimo/saimoe)", Accept: "image/*" },
      cache: "no-store",
    });
    if (!r.ok) return new NextResponse("upstream " + r.status, { status: 502 });
    const type = r.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return new NextResponse("not an image", { status: 502 });
    const buf = await r.arrayBuffer();
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": type,
        // 头像基本不变，缓存久一点，省流量也省上游压力
        "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
      },
    });
  } catch {
    return new NextResponse("fetch failed", { status: 502 });
  } finally { clearTimeout(timer); }
}
