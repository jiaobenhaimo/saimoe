import { bangumiApiEnabled } from "./flags";

const BASE = "https://api.bgm.tv";
const UA = process.env.BGM_USER_AGENT || "bgm-saimoe/1.0";

function ensureEnabled() {
  if (!bangumiApiEnabled())
    throw new Error("Bangumi 在线接口已禁用(默认禁用)。请在环境变量设置 BANGUMI_API_ENABLED=true 才能启用搜索 / 抓取 / 批量导入。");
}

export type BgmHit = { bgmId: string; name: string; image: string };

/** Search characters by keyword. Server-side (no CORS). Gated by the flag. */
export async function searchCharacters(keyword: string): Promise<BgmHit[]> {
  ensureEnabled();
  const res = await fetch(`${BASE}/v0/search/characters?limit=12`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({ keyword }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Bangumi search failed: ${res.status}`);
  const json: any = await res.json();
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((d) => ({ bgmId: String(d.id), name: d.name ?? "未知角色", image: pickImage(d.images) }));
}

export type BgmDetail = { bgmId: string; name: string; nameCn: string; image: string };

/** Fetch one character's detail and extract the Simplified-Chinese name. Gated. */
export async function getCharacter(id: string): Promise<BgmDetail> {
  ensureEnabled();
  const res = await fetch(`${BASE}/v0/characters/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json", "User-Agent": UA },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Bangumi character ${id} failed: ${res.status}`);
  const d: any = await res.json();
  return { bgmId: String(d.id), name: d.name ?? "未知角色", nameCn: extractCnName(d.infobox) || "", image: pickImage(d.images) };
}

/** Fetch the whole cast of a subject (anime/game/…). Gated. No per-char CN name
 * (would be one request each); uses the cast list's own name + image. */
export async function getSubjectCharacters(subjectId: string): Promise<BgmHit[]> {
  ensureEnabled();
  const res = await fetch(`${BASE}/v0/subjects/${encodeURIComponent(subjectId)}/characters`, {
    headers: { Accept: "application/json", "User-Agent": UA },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Bangumi subject ${subjectId} characters failed: ${res.status}`);
  const data: any = await res.json();
  const arr: any[] = Array.isArray(data) ? data : [];
  return arr.map((c) => ({ bgmId: String(c.id), name: c.name ?? "未知角色", image: pickImage(c.images) }));
}

/** Accepts a raw subject id or a bgm.tv subject URL and returns the numeric id. */
export function parseSubjectId(input: string): string | null {
  const s = input.trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/(?:subject|topic)\/(\d+)/) || s.match(/\/(\d+)(?:\/|$)/);
  return m ? m[1] : null;
}

function pickImage(images: any): string {
  if (!images) return "";
  return images.grid || images.medium || images.small || images.large || "";
}

function extractCnName(infobox: any): string {
  if (!Array.isArray(infobox)) return "";
  const keys = ["简体中文名", "中文名", "简体中文"];
  for (const k of keys) {
    const item = infobox.find((x) => typeof x?.key === "string" && x.key.includes(k));
    if (item) {
      const v = item.value;
      if (typeof v === "string") return v.trim();
      if (Array.isArray(v) && v[0]) return String(v[0]?.v ?? v[0]).trim();
    }
  }
  return "";
}
