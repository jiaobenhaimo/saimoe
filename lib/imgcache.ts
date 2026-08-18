import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * On-disk cache for proxied character icons.
 *
 * Character avatars are the heaviest thing on the page — a 200-character nomination pool is 200
 * images, and every visitor used to fetch all of them from lain.bgm.tv directly. That fails
 * outright on networks that can't reach the image host, and hits Bangumi's hotlink protection.
 * Serving them through this service means Bangumi sees ONE fetch per icon for the whole event
 * instead of one per visitor, and voters see a same-origin image that always loads.
 *
 * Layout: $IMG_CACHE_DIR/<sha256(url)>.<ext> plus a sidecar .meta holding the content type.
 * Default location is under DATA_DIR, so a Docker/Fly persistent volume keeps the cache warm
 * across restarts. Total size is capped; the oldest files are evicted when it's exceeded.
 */

const MAX_BYTES = Math.max(1, Number(process.env.IMG_CACHE_MB) || 512) * 1024 * 1024;
/** Reject anything larger than this — an avatar is tens of KB; this is a memory-safety bound. */
export const MAX_IMAGE_BYTES = Math.max(1, Number(process.env.IMG_MAX_KB) || 4096) * 1024;

function dir(): string {
  return process.env.IMG_CACHE_DIR
    || path.join(process.env.DATA_DIR || path.join(process.cwd(), ".data"), "imgcache");
}

const EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
  "image/gif": ".gif", "image/avif": ".avif",
};

function keyOf(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex");
}

export interface Cached { body: Buffer; type: string }

/** Look up a cached image. Returns null on a miss (or if the cache dir isn't usable). */
export function getCached(url: string): Cached | null {
  try {
    const base = path.join(dir(), keyOf(url));
    const type = fs.readFileSync(base + ".meta", "utf8").trim();
    const ext = EXT[type];
    if (!ext) return null;
    const body = fs.readFileSync(base + ext);
    if (!body.length) return null;
    // touch so eviction treats recently-served icons as hot
    try { const now = new Date(); fs.utimesSync(base + ext, now, now); } catch {}
    return { body, type };
  } catch { return null; }
}

/** Store an image. Best-effort: a cache write failure must never fail the request. */
export function putCached(url: string, body: Buffer, type: string): void {
  const ext = EXT[type];
  if (!ext || !body.length || body.length > MAX_IMAGE_BYTES) return;
  try {
    const d = dir();
    fs.mkdirSync(d, { recursive: true });
    const base = path.join(d, keyOf(url));
    // temp + rename so a concurrent reader never sees a half-written file
    const tmp = base + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, base + ext);
    fs.writeFileSync(base + ".meta", type);
    maybeEvict(d);
  } catch { /* cache is optional */ }
}

let lastEvict = 0;
/** Keep the directory under MAX_BYTES, dropping least-recently-used files first. */
function maybeEvict(d: string): void {
  const now = Date.now();
  if (now - lastEvict < 60_000) return; // scanning the dir on every write would be silly
  lastEvict = now;
  try {
    const files = fs.readdirSync(d)
      .filter((f) => !f.endsWith(".tmp"))
      .map((f) => {
        const p = path.join(d, f);
        try { const st = fs.statSync(p); return { f, p, size: st.size, at: st.mtimeMs }; }
        catch { return null; }
      })
      .filter((x): x is { f: string; p: string; size: number; at: number } => x !== null);
    let total = files.reduce((t, x) => t + x.size, 0);
    if (total <= MAX_BYTES) return;
    files.sort((a, b) => a.at - b.at); // oldest first
    for (const x of files) {
      if (total <= MAX_BYTES * 0.9) break; // drop to 90% so we don't evict again immediately
      try {
        fs.unlinkSync(x.p);
        total -= x.size;
        // remove the paired sidecar/body so we never leave a half-entry behind
        const other = x.f.endsWith(".meta") ? null : x.p.replace(/\.[a-z0-9]+$/, ".meta");
        if (other) { try { fs.unlinkSync(other); } catch {} }
      } catch {}
    }
  } catch { /* ignore */ }
}

/** Cache size, for /api/diag. */
export function imgCacheStats(): { files: number; bytes: number; dir: string } {
  const d = dir();
  try {
    const files = fs.readdirSync(d).filter((f) => !f.endsWith(".tmp") && !f.endsWith(".meta"));
    let bytes = 0;
    for (const f of files) { try { bytes += fs.statSync(path.join(d, f)).size; } catch {} }
    return { files: files.length, bytes, dir: d };
  } catch { return { files: 0, bytes: 0, dir: d }; }
}
