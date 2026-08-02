import { netFetch } from "./net";

const BASE = "https://api.bgm.tv";
// Bangumi blocks generic UAs (e.g. "Bangumi/1.0", "name/1.0"). Use a descriptive
// "developer/app (repo-url)" form. Override with BGM_USER_AGENT for your own.
const UA = process.env.BGM_USER_AGENT || "jiaobenhaimo/saimoe (https://github.com/jiaobenhaimo/saimoe)";

export type BgmHit = { bgmId: string; name: string; image: string };
export type BgmSubject = { subjectId: string; name: string; nameCn: string; image: string; type: number };

function headers(json = false) {
  const h: Record<string, string> = { Accept: "application/json", "User-Agent": UA };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/** fetch + surface the upstream status AND a snippet of Bangumi's error body,
 *  so a failure is diagnosable (403 UA-block vs 4xx bad-request vs network). */
async function bgmFetch(url: string, init: RequestInit, what: string): Promise<any> {
  let res: Response;
  try {
    // 15s 超时,避免网络异常时请求无限挂起;netFetch 走可信 DNS / 固定 IP,避开 DNS 污染
    res = await netFetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch (e: any) {
    // surface the real cause (ENOTFOUND = DNS 解析失败, ECONNREFUSED/超时 = 出网被拦截)
    const code = e?.cause?.code || e?.code || e?.name || "";
    throw new Error(`${what}：网络请求失败（${code || "无法访问 api.bgm.tv"}）。请检查云托管服务是否开启「公网访问」，或容器 DNS/出网是否正常。`);
  }
  if (!res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, 160); } catch {}
    throw new Error(`${what}：Bangumi 返回 ${res.status}${body ? " " + body : ""}`);
  }
  return res.json();
}

/** Search characters by keyword (server-side, no CORS). */
export async function searchCharacters(keyword: string): Promise<BgmHit[]> {
  const json: any = await bgmFetch(`${BASE}/v0/search/characters?limit=15`, {
    method: "POST", headers: headers(true), body: JSON.stringify({ keyword }),
  }, "角色搜索");
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((d) => ({ bgmId: String(d.id), name: d.name ?? "未知角色", image: pickImage(d.images) }));
}

/** Search subjects (anime / game / …) by keyword. */
export async function searchSubjects(keyword: string): Promise<BgmSubject[]> {
  const json: any = await bgmFetch(`${BASE}/v0/search/subjects?limit=15`, {
    method: "POST", headers: headers(true), body: JSON.stringify({ keyword }),
  }, "作品搜索");
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((d) => ({
    subjectId: String(d.id), name: d.name ?? "未知作品",
    nameCn: d.name_cn ?? "", image: pickImage(d.images), type: Number(d.type) || 0,
  }));
}

export type BgmDetail = { bgmId: string; name: string; nameCn: string; image: string };

/** Fetch one character's detail and extract the Simplified-Chinese name. */
export async function getCharacter(id: string): Promise<BgmDetail> {
  const d: any = await bgmFetch(`${BASE}/v0/characters/${encodeURIComponent(id)}`, { headers: headers() }, `角色 ${id}`);
  return { bgmId: String(d.id), name: d.name ?? "未知角色", nameCn: extractCnName(d.infobox) || "", image: pickImage(d.images) };
}

/** Fetch the whole cast of a subject. Uses the cast list's own name + image. */
export async function getSubjectCharacters(subjectId: string): Promise<BgmHit[]> {
  const data: any = await bgmFetch(`${BASE}/v0/subjects/${encodeURIComponent(subjectId)}/characters`, { headers: headers() }, `作品 ${subjectId} 角色列表`);
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
