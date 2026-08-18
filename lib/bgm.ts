/**
 * Server-side Bangumi client.
 *
 * Everything the browser used to do across the border now happens here. Importing one series
 * used to cost the browser ~1 + N + N requests to api.bgm.tv (character list, then a detail
 * fetch per character for the Chinese name, then origin checks), all from whatever connection
 * the voter happened to have. On a mainland mobile network that is the difference between
 * "added" and "spinning forever". The server sits closer to Bangumi, has a warm cache shared
 * across every visitor, and can bound its own concurrency.
 *
 * Three things make this safe to expose:
 *   - CACHE: results are memoised. Character details and subject metadata never change in
 *     practice, so they get a long TTL; searches get a short one.
 *   - LIMIT: a global semaphore caps in-flight upstream requests, so 50 simultaneous imports
 *     can't turn this service into a Bangumi flood.
 *   - SHAPE: callers get exactly the fields the app stores. No proxying of arbitrary paths.
 */

const UA = "saimoe/1.0 (+https://github.com/jiaobenhaimo/saimoe)";
const BASE = "https://api.bgm.tv";

/** Long TTL: character/subject records are effectively immutable for our purposes. */
const TTL_DETAIL = 24 * 3600_000;
/** Short TTL: search results should reflect newly added works within the day. */
const TTL_SEARCH = 10 * 60_000;
const CACHE_MAX = 4000;

type Entry = { at: number; ttl: number; body: unknown };
const cache = new Map<string, Entry>();

function cacheGet(key: string): unknown | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) { cache.delete(key); return undefined; }
  // refresh LRU position
  cache.delete(key); cache.set(key, hit);
  return hit.body;
}
function cacheSet(key: string, body: unknown, ttl: number): void {
  if (cache.size >= CACHE_MAX) {
    // evict the oldest ~10% (Map preserves insertion order, and cacheGet re-inserts on hit)
    for (const k of [...cache.keys()].slice(0, Math.ceil(CACHE_MAX / 10))) cache.delete(k);
  }
  cache.set(key, { at: Date.now(), ttl, body });
}

// ── global concurrency limit ─────────────────────────────────────────────────
const MAX_INFLIGHT = Math.max(1, Number(process.env.BGM_MAX_INFLIGHT) || 6);
let inflight = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (inflight < MAX_INFLIGHT) { inflight++; return; }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inflight++;
}
function release(): void {
  inflight--;
  const next = waiting.shift();
  if (next) next();
}

/** Deduplicate concurrent identical requests: 40 voters importing the same series share one fetch. */
const pending = new Map<string, Promise<unknown>>();

async function upstream(path: string, init: RequestInit = {}, ttl = TTL_DETAIL, timeoutMs = 10_000): Promise<any> {
  const key = (init.method === "POST" ? "P " : "G ") + path + (init.body ? " " + init.body : "");
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  const already = pending.get(key);
  if (already) return already;

  const run = (async () => {
    await acquire();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(BASE + path, {
        ...init,
        signal: ac.signal,
        headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) },
        cache: "no-store",
      });
      if (!r.ok) throw new Error("upstream " + r.status);
      const body = await r.json();
      cacheSet(key, body, ttl);
      return body;
    } finally {
      clearTimeout(timer);
      release();
      pending.delete(key);
    }
  })();
  pending.set(key, run);
  return run;
}

/** Run tasks with bounded parallelism (the semaphore bounds upstream, this bounds fan-out). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── shapes the app actually stores ───────────────────────────────────────────
export interface CharInfo {
  bgmId: string;            // "c1234"
  name: string;             // original (usually Japanese)
  nameCn: string;
  nameEn: string;
  image: string;
  subjectName: string;      // primary work, Chinese
  subjectNameJa: string;
  subjectNameEn: string;
}
export interface SubjectHit {
  subjectId: string; name: string; nameCn: string; image: string; year: string; tags: string[];
}
export type JpVerdict = { ok: boolean | null; reason: string };

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): string => String(v ?? "").replace(/\D/g, "");

/** Normalise a Bangumi image URL: force https, prefer the square "grid" crop. */
export function normalizeImage(url: unknown): string {
  let u = str(url);
  if (!u) return "";
  if (u.startsWith("//")) u = "https:" + u;
  u = u.replace(/^http:\/\//i, "https://");
  return u.replace(/(\/pic\/crt\/)[a-z](\/)/, "$1g$2");
}

function infobox(d: any, keys: string[]): string {
  const box = Array.isArray(d?.infobox) ? d.infobox : [];
  for (const k of keys) {
    const it = box.find((x: any) => typeof x?.key === "string" && x.key.includes(k));
    if (it && typeof it.value === "string" && it.value.trim()) return it.value.trim();
  }
  return "";
}

/** Only real characters — Bangumi type 1. Excludes mecha / ships / organisations. */
const isRealCharacter = (c: any): boolean => c && str(c.name) !== "" && (c.type == null || c.type === 1);

// ── public API ───────────────────────────────────────────────────────────────

/** Search characters by keyword. Returns display-ready rows (no origin check — see jpOfCharacter). */
export async function searchCharacters(keyword: string, limit = 20): Promise<{ bgmId: string; name: string; nameCn: string; nameEn: string; image: string }[]> {
  const j = await upstream(`/v0/search/characters?limit=${Math.min(50, Math.max(1, limit))}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword }),
  }, TTL_SEARCH);
  const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.list) ? j.list : [];
  const seen = new Set<string>();
  const out: { bgmId: string; name: string; nameCn: string; nameEn: string; image: string }[] = [];
  for (const c of arr) {
    if (!isRealCharacter(c)) continue;
    const bgmId = "c" + num(c.id);
    if (bgmId === "c" || seen.has(bgmId)) continue;
    seen.add(bgmId);
    out.push({ bgmId, name: str(c.name), nameCn: "", nameEn: "", image: normalizeImage(c.images?.grid || c.images?.medium) });
  }
  return out;
}

/** Search subjects (anime). Sorted by how well the name matches, like the old client-side ranking. */
export async function searchSubjects(keyword: string, limit = 20): Promise<SubjectHit[]> {
  const j = await upstream(`/search/subject/${encodeURIComponent(keyword)}?type=2&responseGroup=large&max_results=${Math.min(25, Math.max(1, limit))}`, {}, TTL_SEARCH);
  const list = Array.isArray(j?.list) ? j.list : [];
  const lc = keyword.toLowerCase();
  const score = (x: any): number => {
    const n = str(x.name).toLowerCase(), cn = str(x.name_cn).toLowerCase();
    return (n === lc || cn === lc ? 100 : 0)
      + (n.startsWith(lc) || cn.startsWith(lc) ? 20 : 0)
      + (n.includes(lc) || cn.includes(lc) ? 5 : 0)
      + (x.rank ? Math.max(0, 5 - Math.log10(x.rank + 1)) : 0);
  };
  const seen = new Set<string>();
  return list
    .filter((x: any) => x?.id && !seen.has(String(x.id)) && (seen.add(String(x.id)), true))
    .sort((a: any, b: any) => score(b) - score(a))
    .map((x: any): SubjectHit => ({
      subjectId: num(x.id),
      name: str(x.name),
      nameCn: str(x.name_cn),
      image: normalizeImage(x.images?.grid || x.images?.common),
      year: str(x.air_date).slice(0, 4),
      tags: (Array.isArray(x.tags) ? x.tags : []).map((t: any) => str(t?.name || t)).filter(Boolean),
    }));
}

/** Tags + meta_tags of a subject, as plain strings. */
async function subjectTags(subjectId: string): Promise<string[]> {
  const d = await upstream(`/v0/subjects/${subjectId}`);
  return [
    ...(Array.isArray(d?.tags) ? d.tags.map((t: any) => str(t?.name ?? t)) : []),
    ...(Array.isArray(d?.meta_tags) ? d.meta_tags.map((m: any) => str(m?.name ?? m)) : []),
  ].filter(Boolean);
}

/** Names of a subject in all three languages, for storing alongside a character. */
export async function subjectNames(subjectId: string): Promise<{ zh: string; ja: string; en: string }> {
  try {
    const d = await upstream(`/v0/subjects/${subjectId}`);
    return {
      zh: str(d?.name_cn),
      ja: str(d?.name),
      en: infobox(d, ["英文名", "英文標題"]),
    };
  } catch { return { zh: "", ja: "", en: "" }; }
}

/** Does this subject carry the 「日本」 tag? */
export async function jpOfSubject(subjectId: string): Promise<JpVerdict> {
  const id = num(subjectId);
  if (!id) return { ok: null, reason: "无效的作品 id" };
  try {
    const tags = await subjectTags(id);
    if (tags.some((t) => t.includes("日本"))) return { ok: true, reason: `作品 #${id} 带「日本」标签` };
    return { ok: false, reason: `作品 #${id} 的标签里没有「日本」（共 ${tags.length} 个标签）` };
  } catch (e: any) {
    return { ok: null, reason: `查询作品 #${id} 失败：${e?.message || "unknown"}` };
  }
}

/**
 * Origin check for a character: look at its first three related works; if ANY carries the
 * 「日本」 tag the character passes.
 *
 * `ok: null` means we genuinely could not tell (upstream unreachable, or the character has no
 * related works). Never treat null as a failure — a Bangumi outage must not mass-flag the pool.
 */
export async function jpOfCharacter(rawId: string | number): Promise<JpVerdict> {
  const id = num(rawId);
  if (!id) return { ok: null, reason: "无效的角色 id" };
  let subs: any;
  try {
    subs = await upstream(`/v0/characters/${id}/subjects`);
  } catch (e: any) {
    return { ok: null, reason: `查询角色 #${id} 的关联作品失败：${e?.message || "unknown"}` };
  }
  const top = (Array.isArray(subs) ? subs : []).slice(0, 3).map((s: any) => num(s?.id)).filter(Boolean);
  if (!top.length) return { ok: null, reason: `角色 #${id} 没有关联作品，无法判定` };

  const verdicts = await mapLimit(top, 3, (sid) => jpOfSubject(sid));
  if (verdicts.some((v) => v.ok === true)) {
    const hit = verdicts.find((v) => v.ok === true)!;
    return { ok: true, reason: hit.reason };
  }
  // all definitively negative → flagged; any inconclusive → inconclusive
  if (verdicts.every((v) => v.ok === false))
    return { ok: false, reason: `关联作品 ${top.map((t) => "#" + t).join("、")} 均无「日本」标签` };
  return { ok: null, reason: `部分关联作品查询失败，无法判定（${top.map((t) => "#" + t).join("、")}）` };
}

/** Batch origin check keyed by raw character id — used to filter search results. */
export async function jpBatch(rawIds: string[]): Promise<Record<string, boolean | null>> {
  const ids = [...new Set(rawIds.map(num).filter(Boolean))].slice(0, 40);
  const out: Record<string, boolean | null> = {};
  const verdicts = await mapLimit(ids, 4, (id) => jpOfCharacter(id));
  ids.forEach((id, i) => { out[id] = verdicts[i].ok; });
  return out;
}

/** Full detail for one character, including its primary work's names in three languages. */
export async function characterDetail(rawId: string | number): Promise<CharInfo | null> {
  const id = num(rawId);
  if (!id) return null;
  let d: any;
  try { d = await upstream(`/v0/characters/${id}`); } catch { return null; }
  const name = str(d?.name);
  if (!name) return null;

  const info: CharInfo = {
    bgmId: "c" + id,
    name,
    nameCn: infobox(d, ["简体中文名", "中文名"]),
    nameEn: infobox(d, ["英文名"]),
    image: normalizeImage(d?.images?.grid || d?.images?.medium),
    subjectName: "", subjectNameJa: "", subjectNameEn: "",
  };

  // Primary work: prefer the one where this character is credited as 主角, else the first.
  try {
    const subs = await upstream(`/v0/characters/${id}/subjects`);
    const arr = Array.isArray(subs) ? subs : [];
    const main = arr.find((x: any) => str(x?.staff).includes("主角")) || arr[0];
    if (main) {
      info.subjectName = str(main.name_cn);
      info.subjectNameJa = str(main.name);
      if (!info.subjectName || !info.subjectNameEn) {
        const nm = await subjectNames(num(main.id));
        info.subjectName = info.subjectName || nm.zh;
        info.subjectNameJa = info.subjectNameJa || nm.ja;
        info.subjectNameEn = nm.en;
      }
    }
  } catch { /* work names are a nice-to-have; never block adding the character */ }

  return info;
}

/**
 * Every character of a subject, fully resolved (Chinese/English names filled in) — the whole
 * "import a series" job in one server-side call.
 */
export async function subjectCharacters(subjectId: string, max = 60): Promise<CharInfo[]> {
  const sid = num(subjectId);
  if (!sid) return [];
  const arr = await upstream(`/v0/subjects/${sid}/characters`);
  const raw = (Array.isArray(arr) ? arr : []).filter(isRealCharacter).slice(0, Math.max(1, max));
  if (!raw.length) return [];

  const names = await subjectNames(sid);
  const details = await mapLimit(raw, 6, async (c: any) => {
    const id = num(c.id);
    let nameCn = "", nameEn = "";
    try {
      const d = await upstream(`/v0/characters/${id}`);
      nameCn = infobox(d, ["简体中文名", "中文名"]);
      nameEn = infobox(d, ["英文名"]);
    } catch { /* keep the original name only */ }
    return {
      bgmId: "c" + id,
      name: str(c.name),
      nameCn, nameEn,
      image: normalizeImage(c.images?.grid || c.images?.medium),
      subjectName: names.zh,
      subjectNameJa: names.ja,
      subjectNameEn: names.en,
    } satisfies CharInfo;
  });
  return details.filter((c) => c.bgmId !== "c" && c.name);
}

/**
 * Raw passthrough for the LEGACY /api/bgm shapes only.
 *
 * A voter whose tab was loaded before this deploy is still running the old client code, which
 * expects Bangumi's own JSON. Removing those endpoints would break them until they reload — during
 * a live round that is not acceptable. The path is restricted to the exact endpoints the old
 * client used, so this is not a general-purpose proxy.
 */
export async function rawLegacy(kind: "subjectChars" | "charDetail" | "subject" | "charSubjects", id: string): Promise<any> {
  const n = num(id);
  if (!n) throw new Error("invalid id");
  const path = kind === "subjectChars" ? `/v0/subjects/${n}/characters`
    : kind === "charDetail" ? `/v0/characters/${n}`
    : kind === "subject" ? `/v0/subjects/${n}`
    : `/v0/characters/${n}/subjects`;
  return upstream(path);
}

/** Diagnostics for /api/diag: how warm the cache is and whether we're saturated. */
export function bgmStats(): { cached: number; inflight: number; waiting: number; maxInflight: number } {
  return { cached: cache.size, inflight, waiting: waiting.length, maxInflight: MAX_INFLIGHT };
}
