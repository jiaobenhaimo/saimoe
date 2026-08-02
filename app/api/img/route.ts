import { NextRequest } from "next/server";
import { apiEnabled } from "@/lib/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA = process.env.BGM_USER_AGENT || "jiaobenhaimo/saimoe (https://github.com/jiaobenhaimo/saimoe)";
// SSRF guard: only proxy Bangumi image hosts. Anything else is rejected.
function allowed(host: string) {
  return host === "bgm.tv" || host === "lain.bgm.tv" || host.endsWith(".bgm.tv");
}

export async function GET(req: NextRequest) {
  if (!apiEnabled()) return new Response("api disabled", { status: 503 });
  const u = req.nextUrl.searchParams.get("u");
  if (!u) return new Response("missing u", { status: 400 });
  let url: URL;
  try { url = new URL(u); } catch { return new Response("bad url", { status: 400 }); }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return new Response("bad scheme", { status: 400 });
  if (!allowed(url.hostname)) return new Response("host not allowed", { status: 403 });
  try {
    const r = await fetch(url.toString(), {
      headers: { Referer: "https://bgm.tv/", "User-Agent": UA },
      cache: "no-store",
    });
    if (!r.ok) return new Response("upstream " + r.status, { status: 502 });
    const ct = r.headers.get("content-type") || "image/jpeg";
    const buf = await r.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: { "Content-Type": ct, "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return new Response("fetch failed", { status: 502 });
  }
}
