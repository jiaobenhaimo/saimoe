import { NextRequest, NextResponse } from "next/server";
import { apiEnabled } from "@/lib/flags";
import { rateLimited } from "@/lib/ratelimit";
import { clientIp } from "@/lib/ip";
import { getCached, putCached, MAX_IMAGE_BYTES } from "@/lib/imgcache";
import { normalizeImage } from "@/lib/bgm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Character-icon proxy. This is now the PRIMARY path for every avatar on the site, not just a
 * fallback: the browser asks this service, this service asks Bangumi once and keeps the bytes
 * on disk (lib/imgcache). Benefits, in order of how much they matter here:
 *   1. Works on networks that can't reach lain.bgm.tv at all.
 *   2. Bangumi sees one fetch per icon per event instead of one per visitor.
 *   3. No mixed-content breakage from the old API's http:// URLs, and no hotlink referer.
 *
 * Only Bangumi's own hosts are allowed, so this can't be used as an open proxy.
 */
const ALLOW = /^(?:[a-z0-9-]+\.)*(?:bgm\.tv|bangumi\.tv)$/i;

/** Long cache: the bytes for a given icon URL never change. */
const CACHE_CONTROL = "public, max-age=604800, s-maxage=2592000, immutable";
const SAFE_HEADERS = {
  // The upstream declares the type and we re-declare it; forbid sniffing either way.
  "X-Content-Type-Options": "nosniff",
  // Defence in depth: if a non-image ever slipped through, it must not be able to execute.
  "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; sandbox",
};

/** Read a response body, aborting if it exceeds `cap` bytes. Returns null when it does. */
async function readCapped(r: Response, cap: number): Promise<Buffer | null> {
  if (!r.body) {
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > cap ? null : buf;
  }
  const reader = r.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) { try { await reader.cancel(); } catch {} return null; }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

/** Fetch with redirects handled manually, re-validating the host at every hop. */
async function fetchImage(startUrl: URL): Promise<{ body: Buffer; type: string } | { error: string; status: number }> {
  let target = startUrl;
  // Bangumi's image host does redirect (http->https, and between CDN nodes), so we must follow --
  // but `redirect: "follow"` would follow a Location pointing anywhere, including link-local
  // metadata addresses, turning the host allowlist into decoration. Follow manually instead.
  for (let hop = 0; hop < 4; hop++) {
    if (!ALLOW.test(target.hostname)) return { error: "host not allowed", status: 403 };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8_000);
    let r: Response;
    try {
      r = await fetch(target.toString(), {
        signal: ac.signal,
        redirect: "manual",
        // no Referer -- Bangumi's image host rejects hotlinked requests
        headers: { "User-Agent": "saimoe/1.0 (+https://github.com/jiaobenhaimo/saimoe)", Accept: "image/*" },
        cache: "no-store",
      });
    } catch {
      clearTimeout(timer);
      return { error: "fetch failed", status: 502 };
    }
    clearTimeout(timer);

    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return { error: "bad redirect", status: 502 };
      let next: URL;
      try { next = new URL(loc, target); } catch { return { error: "bad redirect", status: 502 }; }
      if (next.protocol !== "https:" && next.protocol !== "http:") return { error: "bad redirect scheme", status: 502 };
      target = next;
      continue;
    }
    if (!r.ok) return { error: "upstream " + r.status, status: 502 };

    const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) return { error: "not an image", status: 502 };

    // Refuse oversized payloads. Content-Length is only a hint, so we also stop reading once the
    // stream passes the cap rather than trusting the header.
    const declared = Number(r.headers.get("content-length") || 0);
    if (declared > MAX_IMAGE_BYTES) return { error: "image too large", status: 502 };
    const body = await readCapped(r, MAX_IMAGE_BYTES);
    if (!body) return { error: "image too large", status: 502 };
    return { body, type };
  }
  return { error: "too many redirects", status: 502 };
}

export async function GET(req: NextRequest) {
  if (!apiEnabled()) return new NextResponse("disabled", { status: 503 });

  const raw = req.nextUrl.searchParams.get("u") || "";
  // Normalise first so http:// and the non-square crop variants share one cache entry with the
  // https/grid form the rest of the app uses.
  const normalized = normalizeImage(raw);
  if (!normalized) return new NextResponse("bad url", { status: 400 });

  let target: URL;
  try { target = new URL(normalized); } catch { return new NextResponse("bad url", { status: 400 }); }
  if (target.protocol !== "https:" && target.protocol !== "http:") return new NextResponse("bad scheme", { status: 400 });
  if (!ALLOW.test(target.hostname)) return new NextResponse("host not allowed", { status: 403 });

  const url = target.toString();

  // Disk-cache hit: costs us nothing upstream, so it isn't rate limited.
  const hit = getCached(url);
  if (hit) {
    return new NextResponse(new Uint8Array(hit.body), {
      status: 200,
      headers: { "Content-Type": hit.type, "Cache-Control": CACHE_CONTROL, "X-Img-Cache": "hit", ...SAFE_HEADERS },
    });
  }

  // Only misses can cost an upstream request, so the limit applies here.
  if (rateLimited("img:" + clientIp(req.headers), 600, 60_000))
    return new NextResponse("too many requests", { status: 429 });

  const got = await fetchImage(target);
  if ("error" in got) return new NextResponse(got.error, { status: got.status });

  putCached(url, got.body, got.type);
  return new NextResponse(new Uint8Array(got.body), {
    status: 200,
    headers: { "Content-Type": got.type, "Cache-Control": CACHE_CONTROL, "X-Img-Cache": "miss", ...SAFE_HEADERS },
  });
}
