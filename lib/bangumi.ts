const BASE = "https://api.bgm.tv";
// Bangumi rejects generic/empty User-Agents with 403. It wants a descriptive UA
// like "developer/app (repo-url)". Override with BGM_USER_AGENT to use your own.
const UA = process.env.BGM_USER_AGENT || "jiaobenhaimo/bgm-saimoe (https://github.com/jiaobenhaimo)";

export type BgmHit = { bgmId: string; name: string; image: string };
export type BgmSubject = { subjectId: string; name: string; nameCn: string; image: string; type: number };

function headers(json = false) {
  const h: Record<string, string> = { Accept: "application/json", "User-Agent": UA };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/** Search characters by keyword (server-side, no CORS). */
export async function searchCharacters(keyword: string): Promise<BgmHit[]> {
  const res = await fetch(`${BASE}/v0/search/characters?limit=15`, {
    method: "POST", headers: headers(true), body: JSON.stringify({ keyword }), cache: "no-store",
  });
  if (!res.ok) throw new Error(`Bangumi 角色搜索返回 ${res.status}`);
  const json: any = await res.json();
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((d) => ({ bgmId: String(d.id), name: d.name ?? "未知角色", image: pickImage(d.images) }));
}

/** Search subjects (anime / game / …) by keyword. */
export async function searchSubjects(keyword: string): Promise<BgmSubject[]> {
  const res = await fetch(`${BASE}/v0/search/subjects?limit=15`, {
    method: "POST", headers: headers(true),
    body: JSON.stringify({ keyword, sort: "rank" }), cache: "no-store",
  });
  if (!res.ok) throw new Error(`Bangumi 作品搜索返回 ${res.status}`);
  const json: any = await res.json();
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((d) => ({
    subjectId: String(d.id), name: d.name ?? "未知作品",
    nameCn: d.name_cn ?? "", image: pickImage(d.images), type: Number(d.type) || 0,
  }));
}

export type BgmDetail = { bgmId: string; name: string; nameCn: string; image: string };

/** Fetch one character's detail and extract the Simplified-Chinese name. */
export async function getCharacter(id: string): Promise<BgmDetail> {
  const res = await fetch(`${BASE}/v0/characters/${encodeURIComponent(id)}`, { headers: headers(), cache: "no-store" });
  if (!res.ok) throw new Error(`Bangumi 角色 ${id} 返回 ${res.status}`);
  const d: any = await res.json();
  return { bgmId: String(d.id), name: d.name ?? "未知角色", nameCn: extractCnName(d.infobox) || "", image: pickImage(d.images) };
}

/** Fetch the whole cast of a subject. Uses the cast list's own name + image. */
export async function getSubjectCharacters(subjectId: string): Promise<BgmHit[]> {
  const res = await fetch(`${BASE}/v0/subjects/${encodeURIComponent(subjectId)}/characters`, { headers: headers(), cache: "no-store" });
  if (!res.ok) throw new Error(`Bangumi 作品 ${subjectId} 角色列表返回 ${res.status}`);
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
  return images.grid || images.medium || images.small || images.common || images.large || "";
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
