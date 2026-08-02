const BASE = "https://api.bgm.tv";
const UA = process.env.BGM_USER_AGENT || "bgm-saimoe/1.0";

export type BgmHit = { bgmId: string; name: string; image: string };

/** Search characters by keyword. Runs server-side so there is no CORS issue. */
export async function searchCharacters(keyword: string): Promise<BgmHit[]> {
  const res = await fetch(`${BASE}/v0/search/characters?limit=12`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ keyword }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Bangumi search failed: ${res.status}`);
  const json: any = await res.json();
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((d) => ({
    bgmId: String(d.id),
    name: d.name ?? "未知角色",
    image: pickImage(d.images),
  }));
}

export type BgmDetail = { bgmId: string; name: string; nameCn: string; image: string };

/** Fetch one character's detail and extract the Simplified-Chinese name from the infobox. */
export async function getCharacter(id: string): Promise<BgmDetail> {
  const res = await fetch(`${BASE}/v0/characters/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json", "User-Agent": UA },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Bangumi character ${id} failed: ${res.status}`);
  const d: any = await res.json();
  return {
    bgmId: String(d.id),
    name: d.name ?? "未知角色",
    nameCn: extractCnName(d.infobox) || "",
    image: pickImage(d.images),
  };
}

function pickImage(images: any): string {
  if (!images) return "";
  return images.grid || images.medium || images.small || images.large || "";
}

/** infobox is an array of {key, value}. The CN name lives under 简体中文名 (value may be string or list). */
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
