"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t, roundLabelT, LANGS, groupLabel, type Lang } from "@/lib/i18n";

type Slim = { id: number; name: string; nameCn: string | null; nameEn?: string | null; image: string | null; subjectName?: string | null; subjectNameJa?: string | null; subjectNameEn?: string | null };
type PoolItem = Slim & { votes: number; voted: boolean; mine: boolean };
type Match = {
  id: number; stage: string; round: number; group: number | null; slot: number;
  a: Slim | null; b: Slim | null;
  votesA: number | null; votesB: number | null; total: number | null; rateA: number | null;
  winnerId: number | null; decided: boolean; myChoice: number | null; commentN: number;
  live?: boolean; matchday?: number; date?: number | null;
};

// ── device fingerprint (sent as x-fp; dedups by device, not by public IP) ──
let FP = "";
// ── coarse device bucket (sent as x-db; NON-blocking metadata only, never dedups) ──
let DB_BUCKET = "";
async function sha256Hex(s: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // non-secure context fallback: two rolling 32-bit hashes → 16 hex chars
    let a = 2166136261, b = 5381;
    for (let i = 0; i < s.length; i++) { a = (a ^ s.charCodeAt(i)) * 16777619 >>> 0; b = ((b << 5) + b + s.charCodeAt(i)) >>> 0; }
    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
  }
}
async function computeFp(): Promise<string> {
  try { const c = localStorage.getItem("saimoe_fp"); if (c) return c; } catch {}
  const parts = [
    navigator.userAgent, navigator.language, (navigator.languages || []).join(","),
    screen.width + "x" + screen.height, String(screen.colorDepth),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    String(navigator.hardwareConcurrency || 0), (navigator as any).platform || "",
    String(window.devicePixelRatio || 0), String((navigator as any).deviceMemory || 0),
    screen.availWidth + "x" + screen.availHeight, String(navigator.maxTouchPoints || 0),
  ];
  try {
    const cv = document.createElement("canvas"); const ctx = cv.getContext("2d");
    if (ctx) { ctx.textBaseline = "top"; ctx.font = "14px 'Arial'"; ctx.fillStyle = "#f60"; ctx.fillRect(0, 0, 60, 20); ctx.fillStyle = "#069"; ctx.fillText("saimoe🎌", 2, 2); parts.push(cv.toDataURL()); }
  } catch {}
  try {
    const gl: any = document.createElement("canvas").getContext("webgl");
    const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) parts.push(String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)), String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)));
  } catch {}
  const hash = await sha256Hex(parts.join("|"));
  try { localStorage.setItem("saimoe_fp", hash); } catch {}
  return hash;
}
// A deliberately COARSE, cross-browser-stable hash. Unlike the fingerprint it omits
// userAgent / canvas / WebGL (those differ per browser on one device). It's reported
// as vote metadata so an operator can later FLAG possible same-device multi-browser
// voting — it is never used to block or de-duplicate a vote. Cross-browser one-vote
// can't be strongly guaranteed client-side; that needs account login.
async function computeDeviceBucket(): Promise<string> {
  try { const c = localStorage.getItem("saimoe_db"); if (c) return c; } catch {}
  const parts = [
    screen.width + "x" + screen.height, screen.availWidth + "x" + screen.availHeight,
    String(screen.colorDepth), Intl.DateTimeFormat().resolvedOptions().timeZone,
    String(navigator.hardwareConcurrency || 0), String((navigator as any).deviceMemory || 0),
    (navigator as any).platform || "", String(navigator.maxTouchPoints || 0),
    String(window.devicePixelRatio || 0),
  ];
  const hash = await sha256Hex("db|" + parts.join("|"));
  try { localStorage.setItem("saimoe_db", hash); } catch {}
  return hash;
}
/** 带超时的 fetch:Bangumi/网络卡住时不会让按钮一直转，到点报错让用户可重试。 */
async function fetchT(url: string, opts: RequestInit = {}, ms = 10_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

/** 直连 Bangumi 与「经本站代理」两条通道同时发，取先成功的那条。
 *  慢网络/跨域被拦时不再等到超时才失败，也不必让用户手动切换。 */
async function firstOk<T>(tasks: (() => Promise<T>)[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let left = tasks.length, done = false, lastErr: any = null;
    if (!left) { reject(new Error("no channel")); return; }
    tasks.forEach((run) => {
      run().then((v) => { if (!done) { done = true; resolve(v); } })
        .catch((e) => { lastErr = e; if (--left === 0 && !done) reject(lastErr); });
    });
  });
}
/** 搜索/取详情统一入口：direct = 浏览器直连；proxy = /api/bgm 代理。
 *  第一次调用两条通道赛跑并「记住赢家」，之后只走赢家（失败才切另一条）。
 *  这样既拿到快的那条，又不会每次都双倍打 Bangumi——上游限流本身就是搜不出来的原因之一。 */
let bgmChannel: "direct" | "proxy" | null = null;
async function bgmJson(direct: () => Promise<Response>, proxyQS: string, ms = 12_000): Promise<any> {
  const asJson = async (r: Response) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); };
  const viaDirect = async () => asJson(await direct());
  const viaProxy = async () => asJson(await fetchT("/api/bgm?" + proxyQS, { cache: "no-store" }, ms));
  if (bgmChannel === "direct") { try { return await viaDirect(); } catch { bgmChannel = "proxy"; return viaProxy(); } }
  if (bgmChannel === "proxy") { try { return await viaProxy(); } catch { bgmChannel = "direct"; return viaDirect(); } }
  return firstOk<any>([
    async () => { const v = await viaDirect(); bgmChannel ??= "direct"; return v; },
    async () => { const v = await viaProxy(); bgmChannel ??= "proxy"; return v; },
  ]);
}

function api(path: string, opts: RequestInit = {}) {
  const headers = new Headers(opts.headers);
  if (FP) headers.set("x-fp", FP);
  if (DB_BUCKET) headers.set("x-db", DB_BUCKET);
  return fetch(path, { ...opts, headers, cache: "no-store" });
}

// ── optimistic nomination helpers： 服务器慢时先本地生效，再由 load() 对齐真实数据 ──
function optimisticNomVote(nom: any, candidateId: number): any {
  if (!nom?.pool) return nom;
  const pool = nom.pool.map((p: any) =>
    p.id === candidateId ? { ...p, voted: !p.voted, votes: Math.max(0, (p.votes || 0) + (p.voted ? -1 : 1)) } : p);
  return { ...nom, pool, myCount: Math.max(0, (nom.myCount || 0) + (nom.pool.find((p: any) => p.id === candidateId)?.voted ? -1 : 1)) };
}
function optimisticNomRemove(nom: any, candidateId: number): any {
  if (!nom?.pool) return nom;
  return { ...nom, pool: nom.pool.filter((p: any) => p.id !== candidateId) };
}

// ── optimistic vote helpers: mutate a shallow copy so the UI reacts before the server replies ──
function optimisticApproval(group: any, candidateId: number): any {
  if (!group || group.mode !== "approval") return group;
  const groups = group.groups.map((g: any) => {
    if (!g.open || !g.members?.some((m: any) => m.id === candidateId)) return g;
    const picked = g.members.find((m: any) => m.id === candidateId)?.mine;
    if (!picked && (g.myPicks ?? 0) >= (group.perGroupVotes ?? 2)) return g; // at cap → no optimistic add
    return { ...g, myPicks: (g.myPicks ?? 0) + (picked ? -1 : 1), members: g.members.map((m: any) => m.id === candidateId ? { ...m, mine: !picked } : m) };
  });
  return { ...group, groups };
}
function flipChoice(list: any[] | undefined, matchupId: number, choiceId: number): any[] | undefined {
  return list?.map((m: any) => m.id === matchupId ? { ...m, myChoice: m.myChoice === choiceId ? null : choiceId } : m);
}
function optimisticChoice(group: any, matchupId: number, choiceId: number): any {
  if (!group || group.mode !== "rr") return group;
  return { ...group, groups: group.groups.map((g: any) => ({ ...g, matchups: flipChoice(g.matchups, matchupId, choiceId) })) };
}
function optimisticKo(ko: any, matchupId: number, choiceId: number): any {
  if (!ko?.rounds) return ko;
  return { ...ko, rounds: ko.rounds.map((r: any) => ({ ...r, matchups: flipChoice(r.matchups, matchupId, choiceId) })) };
}
function optimisticPlayoff(pl: any, matchupId: number, choiceId: number): any {
  if (!pl?.matchups) return pl;
  return { ...pl, matchups: flipChoice(pl.matchups, matchupId, choiceId) };
}

// 浏览器直接加载 Bangumi 图片（用户网络可达，不经服务端）；统一转成方形 grid 尺寸。
function imgSrc(url?: string | null): string {
  if (!url) return "";
  // item4：Bangumi 老接口（/search/subject）返回的是 http:// 链接，而本站是 HTTPS，
  // 浏览器会按「混合内容」直接拦掉，表现就是图片一张都不显示。统一升到 https。
  let u = url.trim();
  if (u.startsWith("//")) u = "https:" + u;
  u = u.replace(/^http:\/\//i, "https://");
  return u.replace(/(\/pic\/crt\/)[a-z](\/)/, "$1g$2");
}
/** 直连图床失败时改走本站代理（部分网络访问不到 lain.bgm.tv）。 */
function imgProxy(url: string): string {
  return "/api/img?u=" + encodeURIComponent(url);
}

function initials(n?: string) { return n?.trim()?.[0]?.toUpperCase() || "?"; }

function Avatar({ c, lg }: { c: Slim | null; lg?: boolean }) {
  const [stage, setStage] = useState<0 | 1 | 2>(0); // 0=直连 1=走代理 2=放弃用首字母
  if (!c) return null;
  const src = imgSrc(c.image);
  if (!src || stage === 2) return <div className={"av-ph" + (lg ? " lg" : "")}>{initials(c.name)}</div>;
  return <img className={"av" + (lg ? " lg" : "")} src={stage === 0 ? src : imgProxy(src)} alt={c.name}
    referrerPolicy="no-referrer" loading="lazy" onError={() => setStage((v) => (v === 0 ? 1 : 2))} />;
}

// 主名按 UI 语言：中文→中文名，英文→英文名，日文→原名；缺失时回退原（日文）名。
/** 缺当前语言时的统一回退顺序：日语 → 中文 → 英语。
 *  （c.name 是 Bangumi 原名，基本即日文名。） */
const pick = (lang: Lang, zh?: string | null, ja?: string | null, en?: string | null): string => {
  // 先 trim 再判空：否则「只有空格」的字段会被当成有值，把回退链截断成空字符串
  const t = (v?: string | null) => (v || "").trim();
  const want = lang === "zh" ? t(zh) : lang === "en" ? t(en) : t(ja);
  return want || t(ja) || t(zh) || t(en);
};
const primaryName = (c: Slim, lang: Lang) => pick(lang, c.nameCn, c.name, c.nameEn) || c.name;
/** 这个名字最终取自哪种语言 —— 用来给元素打 lang，让浏览器挑对汉字字形。 */
const srcLang = (c: Slim | null, lang: Lang): string => {
  if (!c) return lang === "zh" ? "zh-CN" : lang;
  const want = lang === "zh" ? c.nameCn : lang === "en" ? c.nameEn : c.name;
  if (want && want.trim()) return lang === "zh" ? "zh-CN" : lang;
  if (c.name && c.name.trim()) return "ja";          // Bangumi 原名基本是日文
  if (c.nameCn && c.nameCn.trim()) return "zh-CN";
  return "en";
};
const label = (c: Slim | null, lang: Lang) => (c ? primaryName(c, lang) : "—");
// 副行只放「所属作品」。中文/英文界面下不再补显日文角色名：
// 每行都挂一串日文名把列表挤得很满，而且用户看的是中文名。
const sub = (c: Slim | null, lang: Lang) => {
  if (!c) return "";
  return pick(lang, c.subjectName, c.subjectNameJa, c.subjectNameEn);
};

function fmtRemain(ms: number, lang: Lang): string {
  const U = (k: string) => t(lang, k);
  if (ms <= 0) return "0" + U("unit.min");
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (d > 0) return `${d}${U("unit.day")} ${h}${U("unit.hour")} ${m}${U("unit.min")}`;
  if (h > 0) return `${h}${U("unit.hour")} ${m}${U("unit.min")} ${s}${U("unit.sec")}`;
  return `${m}${U("unit.min")} ${s}${U("unit.sec")}`;
}
function fmtAbs(ms: number, lang: Lang): string {
  const loc = lang === "en" ? "en-US" : lang === "ja" ? "ja-JP" : "zh-CN";
  try {
    return new Date(ms).toLocaleString(loc, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function useLang(): [Lang, (l: Lang) => void] {
  const [lang, setLang] = useState<Lang>("zh");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("saimoe_lang") as Lang | null;
      if (saved === "zh" || saved === "en" || saved === "ja") { setLang(saved); return; }
      const n = (navigator.language || "").toLowerCase();
      setLang(n.startsWith("ja") ? "ja" : n.startsWith("zh") ? "zh" : "en");
    } catch {}
  }, []);
  // 让 <html lang> 跟着界面语言走。这不只是无障碍问题：中日共用汉字的字形不同
  // （直/骨/今/令/雪…），浏览器要靠 lang 才能挑对字形，读屏也要靠它选对语音。
  useEffect(() => {
    try { document.documentElement.lang = lang === "zh" ? "zh-CN" : lang === "ja" ? "ja" : "en"; } catch {}
  }, [lang]);
  const set = (l: Lang) => { setLang(l); try { localStorage.setItem("saimoe_lang", l); } catch {} };
  return [lang, set];
}

export default function Page() {
  const [state, setState] = useState<any>(null);
  const [voting, setVoting] = useState<Set<number>>(new Set()); // ids with an in-flight vote (instant button feedback)
  const [nomPending, setNomPending] = useState<Set<string>>(new Set()); // pool/搜索结果里正在提交的项（即时反馈）
  const [justDone, setJustDone] = useState<Set<string>>(new Set()); // 刚提交成功的项：短暂高亮一下，给一个「成功了」的确认
  const [liveMsg, setLiveMsg] = useState(""); // 读屏播报（aria-live）
  /** 成功后的收尾：闪一下 + 轻微触感 + 播报，让点击有明确回应。 */
  const settle = useCallback((key: string, msg: string) => {
    setJustDone((s2) => new Set(s2).add(key));
    setTimeout(() => setJustDone((s2) => { const n = new Set(s2); n.delete(key); return n; }), 700);
    if (msg) setLiveMsg(msg);
    try { (navigator as any).vibrate?.(8); } catch {}
  }, []);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(false);
  const [view, setView] = useState<string | null>(null); // which phase's section to show (null = follow current)
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState("");
  const [subQ, setSubQ] = useState("");
  const [subHits, setSubHits] = useState<any[] | null>(null);
  const [subSearching, setSubSearching] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const busyRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const [sel, setSel] = useState<number | null>(null);
  const [nomErr, setNomErr] = useState("");
  const [voteErr, setVoteErr] = useState(""); // shown during group/knockout (nomErr only renders in the nomination block)
  const [linkErr, setLinkErr] = useState(false);
  useEffect(() => { try { setLinkErr(new URLSearchParams(window.location.search).get("linkerr") === "1"); } catch {} }, []);
  const [lang, setLang] = useLang();
  const T = (k: string, p?: Record<string, string | number>) => t(lang, k, p);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api("/api/state");
      if (r.status === 503) { setState({ disabled: true }); setLoading(false); setLoadErr(false); return; }
      setState(await r.json());
      setLoading(false);
      setLoadErr(false);
    } catch {
      setLoading(false);
      setLoadErr(true);
    }
  }, []);

  useEffect(() => {
    (async () => { FP = await computeFp(); DB_BUCKET = await computeDeviceBucket(); await load(); })();
  }, [load]);

  // 投票失败提示几秒后自动消失，不让旧错误一直挂在屏幕上
  useEffect(() => {
    if (!voteErr) return;
    const t = setTimeout(() => setVoteErr(""), 6000);
    return () => clearTimeout(t);
  }, [voteErr]);
  useEffect(() => {
    const t = setInterval(() => { load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Instant cleanup of the user's own un-voted (0-vote) nominations when they leave.
  // Uses a ref so the unload handler always sees the latest pool without re-binding.
  const orphanRef = useRef(false);
  useEffect(() => {
    const pool: PoolItem[] = state?.nomination?.pool ?? [];
    orphanRef.current = pool.some((p) => p.mine && p.votes === 0);
  }, [state]);
  useEffect(() => {
    const onHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;          // bfcache: user is likely coming back → keep noms
      if (!orphanRef.current) return;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (FP) headers["x-fp"] = FP;   // keepalive fetch preserves headers (sendBeacon can't)
        fetch("/api/nominate", { method: "POST", keepalive: true, headers, body: JSON.stringify({ sweep: true }) });
      } catch {}
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // 角色搜索：v0 只有 POST /v0/search/characters。把它发成 CORS「简单请求」（text/plain）绕过预检；
  // 能否成功取决于 Bangumi 是否给 POST 附跨域头，失败则提示改用「搜作品名」导入。
  const search = async () => {
    const kw = q.trim(); if (!kw) return;
    setSearching(true); setSearchErr(""); setHits(null); setSubHits(null); setImportMsg("");
    try {
      const j = await bgmJson(
        () => fetchT("https://api.bgm.tv/v0/search/characters?limit=20", {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8", Accept: "application/json" },
          body: JSON.stringify({ keyword: kw }),
        }),
        "kind=chars&q=" + encodeURIComponent(kw));
      const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.list) ? j.list : [];
      const seen = new Set<string>();
      const items = arr
        .filter((c: any) => c && c.name && (c.type == null || c.type === 1)) // 只留真正的角色（排除机体/舰船/组织团体）
        .map((c: any) => ({ bgmId: "c" + c.id, name: c.name, nameCn: "", nameEn: "", image: c.images?.grid || c.images?.medium || "" }))
        .filter((c: any) => !seen.has(c.bgmId) && (seen.add(c.bgmId), true));
      // item1：日本作品准入 —— 查每个角色关联的前三部作品是否带「日本」标签，没有就不显示
      let shown = items;
      try {
        const ids = items.map((c: any) => String(c.bgmId).replace(/^c/, "")).filter(Boolean).join(",");
        if (ids) {
          const jr = await fetchT("/api/bgm?kind=jpbatch&ids=" + encodeURIComponent(ids), { cache: "no-store" }, 15_000);
          if (jr.ok) {
            const jp = (await jr.json())?.jp || {};
            const keep = items.filter((c: any) => jp[String(c.bgmId).replace(/^c/, "")] !== false);
            const removed = items.length - keep.length;
            shown = keep;
            if (removed > 0) setImportMsg(T("jp.filtered", { n: removed }));
          }
        }
      } catch { /* 判定失败就不过滤，避免因网络问题什么都搜不到 */ }
      setHits(shown);
      if (shown.length === 0) setSearchErr(T("search.trysubject"));
    } catch (e: any) { setSearchErr(T("search.fail", { err: e?.message || "网络不可达，可改用搜作品名导入" })); setHits([]); }
    finally { setSearching(false); }
  };

  // 浏览器直接调 Bangumi 老接口 GET /search/subject（GET 支持跨域，无需代理/服务端）
  const searchSubjects = async () => {
    const kw = subQ.trim(); if (!kw) return;
    setSubSearching(true); setImportMsg(""); setSubHits(null); setHits(null); setSearchErr("");
    try {
      const j = await bgmJson(
        async () => {
          const rr = await fetchT(`https://api.bgm.tv/search/subject/${encodeURIComponent(kw)}?type=2&responseGroup=large&max_results=20`, { headers: { Accept: "application/json" } });
          // 老接口偶尔返回 HTML 错误页：视为该通道失败，让代理通道接手
          if (!(rr.headers.get("content-type") || "").includes("json")) throw new Error("not json");
          return rr;
        },
        "kind=subjects&q=" + encodeURIComponent(kw));
      const list = Array.isArray(j?.list) ? j.list : [];
      const lc = kw.toLowerCase();
      const seen = new Set<string>();
      const score = (x: any) => {
        const n = String(x.name || "").toLowerCase(), cn = String(x.name_cn || "").toLowerCase();
        return (n === lc || cn === lc ? 100 : 0) + (n.startsWith(lc) || cn.startsWith(lc) ? 20 : 0) + (n.includes(lc) || cn.includes(lc) ? 5 : 0) + (x.rank ? Math.max(0, 5 - Math.log10(x.rank + 1)) : 0);
      };
      const mapped = list
        .filter((x: any) => x?.id && !seen.has(String(x.id)) && (seen.add(String(x.id)), true))
        .sort((a: any, b: any) => score(b) - score(a))
        .map((x: any) => ({ subjectId: String(x.id), name: x.name || "", nameCn: x.name_cn || "", image: x.images?.grid || x.images?.common || "", year: String(x.air_date || "").slice(0, 4), tags: (Array.isArray(x.tags) ? x.tags : []).map((t: any) => String(t?.name || t)) }))
        .filter((x: any) => !blockedReason(x.nameCn || x.name, x.tags));
      setSubHits(mapped);
    } catch { setImportMsg(T("subject.neterr")); setSubHits([]); }
    finally { setSubSearching(false); }
  };

  const post = async (body: any) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    try {
      const r = await api("/api/nominate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return await r.json();
    } finally { busyRef.current = false; }
  };
  /** item3：与服务端同一套黑名单判定（前端过滤只为少点无效点击，真正把关在 /api/nominate）。 */
  const blockedReason = (subjectName: string, tags: string[] = []): string | null => {
    const bs: string[] = state?.competition?.blockedSubjects || [];
    const bt: string[] = state?.competition?.blockedTags || [];
    const n = (x: string) => String(x || "").trim().toLowerCase();
    const sn = n(subjectName);
    for (const b of bs) if (sn && n(b) && sn.includes(n(b))) return `作品「${b}」不参与本届`;
    const tn = tags.map(n);
    for (const b of bt) if (n(b) && tn.some((t) => t === n(b))) return `标签「${b}」不参与本届`;
    return null;
  };

  /** item2：取角色最主要的关联作品名（优先主角作品，其次第一部）。查不到返回空串，不阻断提名。 */
  const primarySubject = async (rawId: string): Promise<{ zh: string; ja: string }> => {
    try {
      const subs = await bgmJson(
        () => fetchT(`https://api.bgm.tv/v0/characters/${encodeURIComponent(rawId)}/subjects`, { headers: { Accept: "application/json" } }),
        "kind=charSubjects&id=" + encodeURIComponent(rawId));
      const arr = Array.isArray(subs) ? subs : [];
      if (!arr.length) return { zh: "", ja: "" };
      const main = arr.find((x: any) => String(x?.staff || "").includes("主角")) || arr[0];
      return { zh: String(main?.name_cn || main?.name || ""), ja: String(main?.name || "") };
    } catch { return { zh: "", ja: "" }; }
  };

  // ── 日本产地软校验（方案 A）：查 bangumi 作品 tag 是否含「日本」。返回 true/false/null（null=查不了，不阻断） ──
  const subjectHasJP = async (subjectId: string | number): Promise<boolean | null> => {
    try {
      const d = await bgmJson(
        () => fetchT(`https://api.bgm.tv/v0/subjects/${encodeURIComponent(String(subjectId))}`, { headers: { Accept: "application/json" } }),
        "kind=subject&id=" + encodeURIComponent(String(subjectId).replace(/\D/g, "")));
      const names: string[] = [
        ...((Array.isArray(d?.tags) ? d.tags : []).map((t: any) => (typeof t === "string" ? t : t?.name || ""))),
        ...((Array.isArray(d?.meta_tags) ? d.meta_tags : []).map((m: any) => (typeof m === "string" ? m : m?.name || ""))),
      ];
      return names.some((n) => n.includes("日本"));
    } catch { return null; }
  };
  const characterHasJP = async (rawId: string | number): Promise<boolean | null> => {
    try {
      const subs = await bgmJson(
        () => fetchT(`https://api.bgm.tv/v0/characters/${encodeURIComponent(String(rawId))}/subjects`, { headers: { Accept: "application/json" } }),
        "kind=charSubjects&id=" + encodeURIComponent(String(rawId).replace(/\D/g, "")));
      const ids = (Array.isArray(subs) ? subs : []).map((s: any) => s?.id).filter(Boolean).slice(0, 3);
      if (!ids.length) return null;
      for (const id of ids) { const jp = await subjectHasJP(id); if (jp) return true; }
      return false;
    } catch { return null; }
  };

  const nominate = async (h: any) => {
    setImportMsg("");
    const key = "a" + h.bgmId;
    if (nomPending.has(key)) return;
    setNomPending((s2) => new Set(s2).add(key));
    try {
      // item2：单个角色也带上「所属作品」（取关联作品里最主要的一部），列表和赛程里就能显示出处
      const rawId0 = String(h.bgmId).replace(/^c/, "");
      // 查作品名最多等 1.5 秒：拿到就带上，慢就先把角色加进去，不让「添加」被跨境往返拖住
      const sj = rawId0 && !h.subjectName
        ? await Promise.race([primarySubject(rawId0), new Promise<{ zh: string; ja: string }>((r) => setTimeout(() => r({ zh: "", ja: "" }), 1500))])
        : { zh: h.subjectName || "", ja: "" };
      const j = await post({ batch: [{ bgmId: h.bgmId, name: h.name, nameCn: h.nameCn, image: h.image, subjectName: sj.zh, subjectNameJa: sj.ja }] });
      if (j?.error) setImportMsg(j.error);
      else settle(key, T("nom.plus"));
    } catch { setImportMsg(T("net.slow")); }
    finally { setNomPending((s2) => { const n = new Set(s2); n.delete(key); return n; }); }
    void load(); // 后台刷新提名池
    // 软校验（纯浏览器端，慢也不阻塞界面）：非日本（明确 false）才警告；查不了（null）不打扰
    const rawId = String(h.bgmId).replace(/^c/, "");
    if (rawId) void characterHasJP(rawId).then((jp) => { if (jp === false) setImportMsg(T("jp.warn.char")); }).catch(() => {});
  };
  // 浏览器直接调 GET（取角色列表 + 逐个补中文名），再交服务端存储；顺带记录作品名。
  const importSubject = async (subjectId: string, subjectName: string, subjectNameJa = "") => {
    const deny = blockedReason(subjectName);
    if (deny) { setImportMsg(deny); return; }
    setImportMsg(T("import.progress", { name: subjectName }));
    try {
      const arr = await bgmJson(
        () => fetchT(`https://api.bgm.tv/v0/subjects/${encodeURIComponent(subjectId)}/characters`, { headers: { Accept: "application/json" } }),
        "kind=subjectChars&id=" + encodeURIComponent(String(subjectId).replace(/\D/g, "")));
      const chars = (Array.isArray(arr) ? arr : [])
        .filter((c: any) => c && c.name && (c.type == null || c.type === 1)) // 只留真正的角色
        .map((c: any) => ({ rawId: c.id, bgmId: "c" + c.id, name: c.name, nameCn: "", nameEn: "", image: c.images?.grid || c.images?.medium || "", subjectName, subjectNameJa }))
        .slice(0, 60);
      if (!chars.length) { setImportMsg(T("import.fail", { err: "no characters" })); return; }
      // 补中文名：逐个取角色详情 infobox 的「简体中文名」（小并发，尽力而为）
      for (let i = 0; i < chars.length; i += 8) {
        setImportMsg(T("import.progress", { name: `${subjectName}(${i}/${chars.length})` }));
        await Promise.all(chars.slice(i, i + 8).map(async (ch: any) => {
          try {
            const d = await bgmJson(
              () => fetchT(`https://api.bgm.tv/v0/characters/${ch.rawId}`, { headers: { Accept: "application/json" } }),
              "kind=charDetail&id=" + encodeURIComponent(String(ch.rawId)));
            const box = Array.isArray(d?.infobox) ? d.infobox : [];
            const it = box.find((x: any) => typeof x?.key === "string" && (x.key.includes("简体中文名") || x.key === "中文名"));
            if (it && typeof it.value === "string") ch.nameCn = it.value;
            const en = box.find((x: any) => typeof x?.key === "string" && x.key.includes("英文名"));
            if (en && typeof en.value === "string") ch.nameEn = en.value;
          } catch {}
        }));
      }
      const batch = chars.map((c: any) => ({ bgmId: c.bgmId, name: c.name, nameCn: c.nameCn, nameEn: c.nameEn || "", image: c.image, subjectName: c.subjectName }));
      const j = await post({ batch });
      const jp = await subjectHasJP(subjectId); // 方案 A：软校验，仅在明确非日本时追加提醒
      const warn = jp === false ? " " + T("jp.warn.subject") : "";
      setImportMsg((j?.error ? T("import.fail", { err: j.error }) : T("import.done", { name: subjectName, added: j?.added ?? 0, imported: chars.length })) + warn);
      await load();
    } catch (e: any) {
      setImportMsg(T("import.fail", { err: e?.message || "network" }));
    }
  };

  const frozen = !!state?.competition?.freeze?.active;                                   // 维护中：谁都不能投
  const gated = !frozen && !!state?.voteGate?.on && !state?.voteGate?.canVote;            // 只是缺公众号链接
  const canVote = !frozen && (!state?.voteGate?.on || !!state?.voteGate?.canVote);
  const nomVote = async (candidateId: number) => {
    setNomErr("");
    if (!canVote) { setNomErr(frozen ? (state?.competition?.freeze?.note || T("freeze.now")) : T("gate.readonly")); return; }
    const key = "n" + candidateId;
    if (nomPending.has(key)) return;
    const before = state; // 失败时回滚到点击前，避免界面停在错误状态
    const wasVoted = !!state?.nomination?.pool?.find((x: any) => x.id === candidateId)?.voted;
    setNomPending((s2) => new Set(s2).add(key));
    // 先本地生效：服务端往返慢也不会「点了没反应」
    setState((prev: any) => prev ? { ...prev, nomination: optimisticNomVote(prev.nomination, candidateId) } : prev);
    try {
      const r = await api("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "nominate", candidateId }) });
      const j = await r.json().catch(() => ({}));
      if (j?.error) { setNomErr(j.error); if (before) setState(before); }
      else settle(key, wasVoted ? T("nom.vote") : T("nom.voted"));
    } catch { setNomErr(T("net.slow")); if (before) setState(before); }
    finally {
      setNomPending((s2) => { const n = new Set(s2); n.delete(key); return n; });
      void load(); // 后台对齐，不阻塞交互
    }
  };
  const nomRemove = async (candidateId: number) => {
    setNomErr("");
    const key = "r" + candidateId;
    if (nomPending.has(key)) return;
    setNomPending((s2) => new Set(s2).add(key));
    setState((prev: any) => prev ? { ...prev, nomination: optimisticNomRemove(prev.nomination, candidateId) } : prev);
    try {
      const j = await post({ remove: candidateId });
      if (j?.error) setNomErr(j.error);
    } catch { setNomErr(T("net.slow")); }
    finally {
      setNomPending((s2) => { const n = new Set(s2); n.delete(key); return n; });
      void load();
    }
  };
  const matchVote = async (matchupId: number, choiceId: number) => {
    if (voting.has(matchupId)) return;
    if (!canVote) {
      // 对战卡两侧是可点的按钮（没有禁用态），静默无反应会让人以为页面坏了
      setVoteErr(frozen ? (state?.competition?.freeze?.note || T("freeze.now")) : T("gate.readonly"));
      return;
    }
    const before = state;
    setVoteErr("");
    setVoting((s) => new Set(s).add(matchupId));
    // optimistic: reflect the pick immediately so the UI responds without waiting for the round-trip
    setState((prev: any) => prev ? { ...prev, group: optimisticChoice(prev.group, matchupId, choiceId), knockout: optimisticKo(prev.knockout, matchupId, choiceId), playoff: optimisticPlayoff(prev.playoff, matchupId, choiceId) } : prev);
    try {
      const r = await api("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "match", matchupId, choiceId }) });
      const j = await r.json().catch(() => ({}));
      if (j?.error) { setVoteErr(j.error); if (before) setState(before); }
      else settle("m" + matchupId, T("vote.badge.done"));
      await load();
    } catch { setVoteErr(T("net.slow")); if (before) setState(before); }
    finally { setVoting((s) => { const n = new Set(s); n.delete(matchupId); return n; }); }
  };
  const approvalVote = async (candidateId: number) => {
    if (!canVote || voting.has(candidateId)) return;
    const before = state;
    setVoting((s) => new Set(s).add(candidateId));
    setVoteErr("");
    // optimistic: toggle my pick locally right away
    setState((prev: any) => prev ? { ...prev, group: optimisticApproval(prev.group, candidateId) } : prev);
    try {
      const r = await api("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "approval", candidateId }) });
      const j = await r.json().catch(() => ({}));
      if (j?.error) { setVoteErr(j.error); if (before) setState(before); }
      else settle("g" + candidateId, T("gb.picked"));
      await load();
    } catch { setVoteErr(T("net.slow")); if (before) setState(before); }
    finally { setVoting((s) => { const n = new Set(s); n.delete(candidateId); return n; }); }
  };

  const comp = state?.competition;
  const phase: string = comp?.phase ?? "nomination";

  const phases: [string, string][] = [["nomination", T("phase.nomination")], ["group", T("phase.group")], ["knockout", T("phase.knockout")]];

  // ── phase navigation: chips are buttons that switch which phase's results are shown ──
  const champion = state?.knockout?.champion ?? null;
  const hasView: Record<string, boolean> = {
    nomination: !!comp,
    group: !!state?.group,
    knockout: !!(state?.playoff || (state?.knockout && state.knockout.rounds?.length)),
    finished: !!champion,
  };
  // map the live phase onto one of the chips （playoff & finished ride under 淘汰赛）
  const currentKey = phase === "playoff" || phase === "finished" ? "knockout" : phase;
  const viewKey = (view && hasView[view]) ? view : currentKey;
  const showKey = viewKey === "finished" ? "knockout" : viewKey; // 冠军 chip shows the knockout section (champion + bracket)
  const viewingPast = viewKey !== currentKey;

  // matches open for voting RIGHT NOW (drives the "现在投票" panel)， for the current phase only
  const openMatches: Match[] =
    phase === "group" ? (state?.group?.mode === "approval" ? [] : (state?.group?.groups ?? []).flatMap((g: any) => g.matchups ?? []).filter((m: Match) => m.live && !m.decided && m.a && m.b))
    : phase === "playoff" ? (state?.playoff?.matchups ?? []).filter((m: Match) => m.live && !m.decided && m.a && m.b)
    : phase === "knockout" ? (state?.knockout?.rounds ?? []).flatMap((r: any) => r.matchups).filter((m: Match) => !m.decided && m.a && m.b)
    : [];
  const openVoted = openMatches.filter((m) => m.myChoice != null).length;

  // 下一批对局（下一比赛日 / 下一轮的预告）
  const nextMatches: Match[] =
    phase === "group" ? (state?.group?.mode === "approval" ? [] : (state?.group?.groups ?? []).flatMap((g: any) => g.matchups ?? []).filter((m: Match) => (m.matchday ?? 0) === ((state?.group?.matchday ?? 0) + 1) && m.a && m.b))
    : [];

  const deadline: number | null =
    phase === "nomination" ? comp?.nomEndsAt ?? null :
    phase === "group" ? comp?.groupRoundEndsAt ?? null :
    phase === "playoff" ? comp?.groupRoundEndsAt ?? null :
    phase === "knockout" ? comp?.koRoundEndsAt ?? null : null;
  const deadlineLabel =
    phase === "nomination" ? T("dl.nomination") : phase === "group" ? T("dl.group") : phase === "playoff" ? T("dl.playoff") : phase === "knockout" ? T("dl.knockout") : "";

  const koRounds: any[] = state?.knockout?.rounds || [];
  const selMatch: Match | null = sel != null ? (koRounds.flatMap((r: any) => r.matchups).find((m: Match) => m.id === sel) || null) : null;

  return (
    <main className="wrap">
      <div className="langbar">{LANGS.map((L) => <button key={L.code} type="button" className={"lang" + (lang === L.code ? " on" : "")} onClick={() => setLang(L.code)}>{L.label}</button>)}</div>
      {state?.competition?.freeze?.active && (
        <div className="gate-banner" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
          <b>{state.competition.freeze.note || T("freeze.now")}</b>
          {state.competition.freeze.to ? " · " + T("freeze.until", { to: fmtAbs(state.competition.freeze.to, lang) }) : ""}
        </div>
      )}
      {!state?.competition?.freeze?.active && state?.competition?.freeze?.upcoming && state?.competition?.freeze?.from && (
        <div className="gate-banner">
          {T("freeze.plan", { from: fmtAbs(state.competition.freeze.from, lang) })}
          {state.competition.freeze.to ? " · " + T("freeze.until", { to: fmtAbs(state.competition.freeze.to, lang) }) : ""}
        </div>
      )}
      <h1 className="title">{(lang === "en" ? (comp?.titleEn || comp?.title) : lang === "ja" ? (comp?.titleJa || comp?.title) : comp?.title) || T("title")}</h1>
      <p className="subtitle">{(() => {
        const sn = lang === "en" ? (comp?.shortEn || comp?.shortName) : lang === "ja" ? (comp?.shortJa || comp?.shortName) : comp?.shortName;
        const ds = lang === "en" ? (comp?.descEn || comp?.description) : lang === "ja" ? (comp?.descJa || comp?.description) : comp?.description;
        return (sn ? `${sn} · ` : "") + (ds || T("subtitle"));
      })()}</p>
      <div className="phasebar">
        {phases.map(([p, name]) => {
          const enabled = comp && hasView[p];
          const isCurrent = comp && p === currentKey;
          const isSel = comp && p === viewKey;
          return (
            <button
              key={p}
              type="button"
              className={"chip" + (isCurrent ? " on" : "") + (isSel ? " sel" : "")}
              disabled={!enabled}
              aria-pressed={isSel}
              title={enabled ? "" : T("view.locked")}
              onClick={() => enabled && setView(p)}
            >{name}{isCurrent ? " ●" : ""}</button>
          );
        })}
      </div>
      <div className="hint" style={{ marginTop: 6 }}><a href="/rules">{T("rulesLink")}</a></div>
      {!frozen && (linkErr || gated) && (
        <div className="gate-banner">{linkErr ? T("gate.linkErr") : T("gate.readonly")}</div>
      )}

      {!loading && comp && deadline && phase !== "finished" && (
        <div className="deadline">
          <span className="dl-label">{deadlineLabel}</span>
          <span className="dl-time">{fmtAbs(deadline, lang)}</span>
          <span className="dl-remain">{deadline > now ? T("dl.remain", { t: fmtRemain(deadline - now, lang) }) : T("dl.over")}</span>
        </div>
      )}

      {!loading && comp && openMatches.length > 0 && (
        <div className="votenow">
          <div className="votenow-h">
            <span className="votenow-title">🔴 {T("vote.now.title")}</span>
            <span className="votenow-prog">{T("vote.now.progress", { x: openVoted, n: openMatches.length })}</span>
          </div>
          <div className="votenow-grid">
            {openMatches.map((m) => <MatchCard key={"vn" + m.id} m={m} onVote={matchVote} lang={lang} compact />)}
          </div>
        </div>
      )}

      {/* ── 下一轮比赛预告 ── */}
      {!loading && comp && (
        phase === "group" ? (nextMatches.length > 0 && (
          <div className="nextup">
            <div className="nextup-h">📅 {T("next.group", { d: (state?.group?.matchday ?? 0) + 1, n: state?.group?.matchdayCount ?? 0 })}</div>
            <div className="nextup-list">
              {nextMatches.map((m) => (
                <div className="nextup-row" key={m.id}>
                  <span className="nextup-match">{label(m.a, lang)} <span className="vs-mini">vs</span> {label(m.b, lang)}</span>
                  <span className="nextup-date num">{m.date ? fmtAbs(m.date, lang) : T("match.upcoming")}</span>
                </div>
              ))}
            </div>
          </div>
        ))
        : phase === "knockout" && state?.knockout?.nextLabel ? (
          <div className="nextup">
            <div className="nextup-h">📅 {T("next.title")}</div>
            <div className="nextup-row"><span className="nextup-match">{T("next.round")}: {roundLabelT(lang, state.knockout.nextLabel)}</span></div>
          </div>
        ) : null
      )}

      {loading && (
        <div className="skel-wrap">
          {[0, 1, 2, 3].map((i) => <div className="skel-row" key={i}><div className="skel av" /><div className="skel line" /></div>)}
        </div>
      )}

      {!loading && loadErr && (
        <div className="empty"><div className="big">📡</div>
          <p style={{ color: "var(--ink)", fontWeight: 700 }}>{T("err.load.title")}</p>
          <p>{T("err.load.body")}</p>
          <button className="btn solid" onClick={load}>{T("common.retry")}</button></div>
      )}

      {!loading && !loadErr && state?.disabled && (
        <div className="empty"><div className="big">🚧</div>
          <p style={{ color: "var(--ink)", fontWeight: 700 }}>{T("disabled.title")}</p>
          <p>{T("disabled.body")}</p></div>
      )}

      {!loading && !state?.disabled && !comp && (
        <div className="empty"><div className="big">🎬</div>
          <p style={{ color: "var(--ink)", fontWeight: 700 }}>{T("nocomp.title")}</p>
          <p>{T("nocomp.body")}</p></div>
      )}

      {/* ── NOMINATION (interactive; only during the live nomination phase) ── */}
      {!loading && comp && showKey === "nomination" && phase === "nomination" && (
        <>
          <div className="sectlabel">{T("nom.section")}</div>
          <div className="searchbox">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder={T("nom.ph.char")} />
            <button onClick={search} disabled={searching || !q.trim()}>{searching ? T("common.searching") : T("nom.searchChar")}</button>
          </div>
          <div className="searchbox">
            <input value={subQ} onChange={(e) => setSubQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && searchSubjects()} placeholder={T("nom.ph.subject")} />
            <button onClick={searchSubjects} disabled={subSearching || !subQ.trim()}>{subSearching ? T("common.searching") : T("nom.searchSubject")}</button>
          </div>
          {importMsg && <div className="hint">{importMsg}</div>}

          {subHits && (
            <div className="results">
              {subHits.length === 0 && <div className="rrow"><span className="hint">{T("nom.noSubject")}</span></div>}
              {subHits.map((s) => (
                <div className="rrow" key={s.subjectId}>
                  <Avatar c={{ id: 0, name: s.nameCn || s.name, nameCn: null, image: s.image }} />
                  <div className="meta"><div className="nm">{s.nameCn || s.name}</div><div className="sub">{s.nameCn && s.nameCn !== s.name ? s.name + " · " : ""}{T("nom.subjectTag")}{s.year ? " · " + s.year : ""} · #{s.subjectId}</div></div>
                  <button className="btn" onClick={() => importSubject(s.subjectId, s.nameCn || s.name, s.name)}>{T("nom.importAll")}</button>
                </div>
              ))}
            </div>
          )}

          {searchErr && <div className="hint" style={{ color: "var(--rose-deep)" }}>{searchErr}</div>}
          {hits && hits.length > 0 && (
            <div className="results">
              {hits.length === 0 && <div className="rrow"><span className="hint">{T("nom.noChar")}</span></div>}
              {hits.map((h) => (
                <div className="rrow" key={h.bgmId}>
                  <Avatar c={{ id: 0, name: h.name, nameCn: null, image: h.image }} />
                  <div className="meta"><div className="nm">{h.name}</div><div className="sub">{T("nom.charTag")} · #{h.bgmId}</div></div>
                  <button className={"btn" + (nomPending.has("a" + h.bgmId) ? " pending" : "") + (justDone.has("a" + h.bgmId) ? " flash" : "")}
                    aria-busy={nomPending.has("a" + h.bgmId)} onClick={() => nominate(h)}>{T("nom.plus")}</button>
                </div>
              ))}
            </div>
          )}

          <div className="sec"><h2>{T("nom.poolTitle")}</h2><div className="meta2"><b>{state.nomination.pool.length}</b> {T("nom.countSuffix")}</div></div>
          <div className="hint">
            {state.nomination.userLimit > 0 ? T("nom.limitOn", { n: state.nomination.userLimit, x: state.nomination.myCount }) : T("nom.limitOff")}
            {state.nomination.minVotes > 0 ? T("nom.minVotes", { n: state.nomination.minVotes }) : ""}
          </div>
          {nomErr && <div className="hint" style={{ color: "var(--rose-deep)" }}>{nomErr}</div>}
          {state.nomination.pool.length === 0 ? (
            <div className="empty">{T("nom.empty")}</div>
          ) : (
            <div className="results pool">
              {state.nomination.pool.map((p: PoolItem, i: number) => (
                <div className="prow" key={p.id}>
                  <div className="rankn num">{i + 1}</div>
                  <Avatar c={p} />
                  <div className="meta"><div className="nm" lang={srcLang(p, lang)}>{label(p, lang)}</div>
                    <div className="sub">{sub(p, lang)}{(p as any).mergedInto ? " · " + T("nom.mergedInto", { name: (p as any).mergedInto }) : ""}</div></div>
                  <div className="votecell num"><div className="c">{p.votes}</div><div className="l">{T("nom.voteLabel")}</div></div>
                  <button className={"btn" + (p.voted ? " solid" : "") + (nomPending.has("n" + p.id) ? " pending" : "") + (justDone.has("n" + p.id) ? " flash" : "")}
                    disabled={!canVote} aria-busy={nomPending.has("n" + p.id)} onClick={() => nomVote(p.id)}>{p.voted ? T("nom.voted") : T("nom.vote")}</button>
                  {p.mine && p.votes === 0 && <button className={"btn ghost" + (nomPending.has("r" + p.id) ? " pending" : "")} aria-busy={nomPending.has("r" + p.id)} onClick={() => nomRemove(p.id)}>{T("nom.remove")}</button>}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── NOMINATION RESULTS (read-only, after the phase has moved on) ── */}
      {!loading && comp && showKey === "nomination" && phase !== "nomination" && state?.nominationRanking && (
        <>
          <div className="viewback">{T("view.back")}</div>
          <div className="sec"><h2>{T("nom.result.title")}</h2><div className="meta2"><b>{state.nominationRanking.length}</b> {T("nom.countSuffix")}</div></div>
          <div className="results pool">
            {state.nominationRanking.map((p: any, i: number) => (
              <div className="prow" key={p.id}>
                <div className="rankn num">{i + 1}</div>
                <Avatar c={p} />
                <div className="meta"><div className="nm" lang={srcLang(p, lang)}>{label(p, lang)}</div><div className="sub">{sub(p, lang)}</div></div>
                <div className="votecell num"><div className="c">{p.votes}</div><div className="l">{T("nom.voteLabel")}</div></div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── GROUP ── */}
      {!loading && comp && showKey === "group" && state?.group && (
        <>
          {viewingPast && <div className="viewback">{T("view.back")}</div>}
          <div className="sec"><h2>{T("group.title")}</h2><div className="meta2">{comp.koTarget ? T((comp.groupsCount && comp.koTarget <= 2 * comp.groupsCount) ? "group.wc2" : "group.wc", { n: comp.koTarget }) : ""}</div></div>
          {state.group.matchdayCount > 1 && <div className="hint">{T("group.matchday", { d: state.group.matchday, n: state.group.matchdayCount })}</div>}
          <div className="groupwrap">
            {state.group.mode === "approval"
              ? state.group.groups.map((g: any) => {
                const row = (m: any) => (
                  <li key={m.id} className={(m.mine ? "mine " : "") + (m.advancing ? "adv" : "")}>
                    <Avatar c={m} />
                    <div className="meta"><div className="nm">{label(m, lang)}</div>
                      {m.votes != null && <div className="sub">{m.votes} {T("gb.votes")}{m.advancing ? " · " + T("gb.adv") : ""}</div>}</div>
                    {g.open
                      ? <button className={"btn" + (m.mine ? " solid" : "") + (voting.has(m.id) ? " pending" : "") + (justDone.has("g" + m.id) ? " flash" : "")}
                        disabled={!canVote} aria-busy={voting.has(m.id)} onClick={() => approvalVote(m.id)}>{m.mine ? T("gb.picked") : T("gb.pick")}</button>
                      : <span className="rankpill">{m.rank + 1}</span>}
                  </li>
                );
                const header = (
                  <h3>{T("group.letter", { L: groupLabel(g.group) })}
                    <span className="gstatus">{g.open ? T("gb.open", { n: g.myPicks, max: state.group.perGroupVotes }) : g.closed ? T("gb.closed") : T("gb.upcoming")}</span></h3>
                );
                // finished group: show advancers, tuck the rest behind an expander
                if (g.closed && !g.open) {
                  const adv = g.members.filter((m: any) => m.advancing);
                  const others = g.members.filter((m: any) => !m.advancing);
                  return (
                    <div className="group ballot" key={g.group}>
                      {header}
                      <ul className="ballot-list">{adv.map(row)}</ul>
                      {others.length > 0 && (
                        <details className="more-fold">
                          <summary>{T("gb.showOthers", { n: others.length })}</summary>
                          <ul className="ballot-list" style={{ marginTop: 8 }}>{others.map(row)}</ul>
                        </details>
                      )}
                    </div>
                  );
                }
                return <div className={"group ballot" + (g.open ? " open" : "")} key={g.group}>{header}<ul className="ballot-list">{g.members.map(row)}</ul></div>;
              })
              : state.group.groups.map((g: any) => {
                const liveMs = g.matchups.filter((m: Match) => !m.decided);
                const doneMs = g.matchups.filter((m: Match) => m.decided);
                return (
                  <div className="group" key={g.group}>
                    <h3>{T("group.letter", { L: groupLabel(g.group) })}</h3>
                    <table className="stand">
                      <thead><tr><th>{T("th.rank")}</th><th>{T("th.char")}</th><th style={{ textAlign: "right" }}>{T("th.win")}</th><th style={{ textAlign: "right" }}>{T("th.votes")}</th></tr></thead>
                      <tbody>
                        {g.standings.map((s: any, i: number) => (
                          <tr key={s.id} className={i < 2 ? "adv" : ""}>
                            <td>{i + 1}</td><td>{label(s, lang)}</td><td className="n num">{s.wins}</td><td className="n num">{s.votesFor ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <table className="stand gm-table">
                      <thead><tr><th>{T("th.match")}</th><th>{T("th.date")}</th><th>{T("th.result")}</th></tr></thead>
                      <tbody>
                        {g.matchups.map((m: Match) => (
                          <tr key={m.id} className={m.decided ? "decided" : ""}>
                            <td>{label(m.a, lang)} <span className="vs-mini">vs</span> {label(m.b, lang)}</td>
                            <td className="n num">{m.date ? fmtAbs(m.date, lang) : (m.matchday ? T("group.matchday", { d: m.matchday, n: state.group.matchdayCount }) : "—")}</td>
                            <td className="n">
                              {m.decided
                                ? <span className="win-nm">{m.winnerId === m.a?.id ? label(m.a, lang) : label(m.b, lang)} · {T("match.won")}</span>
                                : m.live ? T("vote.badge.live") : T("vote.badge.upcoming")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {liveMs.map((m: Match) => <MatchCard key={m.id} m={m} onVote={matchVote} lang={lang} busy={voting.has(m.id)} flash={justDone.has("m" + m.id)} />)}
                    {doneMs.length > 0 && (
                      <details className="done-fold">
                        <summary>{T("fold.doneMatches", { n: doneMs.length })}</summary>
                        <div className="fold-body">{doneMs.map((m: Match) => <MatchCard key={m.id} m={m} onVote={matchVote} lang={lang} busy={voting.has(m.id)} flash={justDone.has("m" + m.id)} />)}</div>
                      </details>
                    )}
                  </div>
                );
              })}
          </div>
        </>
      )}

      {/* ── THIRD-PLACE PLAYOFF （shown within the 淘汰赛 view） ── */}
      {!loading && comp && showKey === "knockout" && state?.playoff && (
        <>
          <div className="sec"><h2>{T("playoff.title")}</h2><div className="meta2">{T("playoff.desc", { n: state.playoff.slots })}</div></div>
          <div className="groupwrap">
            <div className="group">
              <table className="stand">
                <thead><tr><th>{T("th.rank")}</th><th>{T("th.char")}</th><th style={{ textAlign: "right" }}>{T("th.win")}</th></tr></thead>
                <tbody>
                  {state.playoff.standings.map((s: any, i: number) => (
                    <tr key={s.id} className={i < state.playoff.slots ? "adv" : ""}>
                      <td>{i + 1}</td><td>{label(s, lang)}</td><td className="n num">{s.wins}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {state.playoff.matchups.map((m: Match) => <MatchCard key={m.id} m={m} onVote={matchVote} lang={lang} busy={voting.has(m.id)} flash={justDone.has("m" + m.id)} />)}
            </div>
          </div>
        </>
      )}

      {/* ── KNOCKOUT / FINISHED ── */}
      {!loading && comp && showKey === "knockout" && state?.knockout && (
        <>
          {viewingPast && !state.knockout.champion && <div className="viewback">{T("view.back")}</div>}
          {state.knockout.champion && (
            <div className="champ">
              <div className="crown">👑</div>
              <div className="who">{label(state.knockout.champion, lang)}</div>
              {sub(state.knockout.champion, lang) && <div className="cn">{sub(state.knockout.champion, lang)}</div>}
              <div className="champ-tag">{T("champ.tag")}</div>
            </div>
          )}
          {state.knockout.champion && (state.knockout.runnerUp || state.knockout.third || state.knockout.fourth) && (
            <div className="podium">
              {state.knockout.runnerUp && <span className="pod"><b>{T("place.2")}</b> {label(state.knockout.runnerUp, lang)}</span>}
              {state.knockout.third && <span className="pod"><b>{T("place.3")}</b> {label(state.knockout.third, lang)}</span>}
              {state.knockout.fourth && <span className="pod"><b>{T("place.4")}</b> {label(state.knockout.fourth, lang)}</span>}
            </div>
          )}
          <div className="sec"><h2>{T("ko.title")}</h2><div className="meta2">{T("ko.hint")}</div></div>
          <div className="bracket">
            {state.knockout.rounds.map((r: any) => (
              <div className="bcol" key={r.round}>
                <div className="bcol-h">{roundLabelT(lang, r.label)}</div>
                <div className="bcol-cells">
                  {r.matchups.map((m: Match) => (
                    <BracketCell key={m.id} m={m} active={sel === m.id} onOpen={() => setSel(sel === m.id ? null : m.id)} lang={lang} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {selMatch && (
            <div className="bracket-detail">
              <div className="sectlabel">{T("ko.detail")}</div>
              <MatchCard m={selMatch} onVote={matchVote} ko lang={lang} />
            </div>
          )}
        </>
      )}

      {voteErr && <div className="toast err" role="alert">{voteErr}</div>}
      <div aria-live="polite" className="sr-only">{liveMsg}</div>
      <div className="foot">
        {T("dataFrom").split("bangumi.tv").map((seg, i) => (
          <span key={i}>{i > 0 && <a href="https://bangumi.tv" target="_blank" rel="noopener noreferrer">bangumi.tv</a>}{seg}</span>
        ))}
        <div className="foot-oss">
          {T("foot.oss", { repo: "%%REPO%%" }).split("%%REPO%%").map((seg, i) => (
            <span key={i}>{i > 0 && <a href="https://github.com/jiaobenhaimo/saimoe" target="_blank" rel="noopener noreferrer">jiaobenhaimo/saimoe</a>}{seg}</span>
          ))}
        </div>
      </div>
    </main>
  );
}

function MatchCard({ m, onVote, ko, lang, compact, busy, flash }: { m: Match; onVote: (mid: number, cid: number) => void; ko?: boolean; lang: Lang; compact?: boolean; busy?: boolean; flash?: boolean }) {
  const T = (k: string, p?: Record<string, string | number>) => t(lang, k, p);
  const revealed = m.decided;
  const pa = revealed && m.total ? ((m.votesA || 0) / m.total) * 100 : 50;
  const live = m.live ?? true;
  const clickable = live && !m.decided && m.a && m.b;
  const status: "live" | "upcoming" | "done" = m.decided ? "done" : (clickable ? "live" : "upcoming");
  const pill = status === "live" ? T("vote.badge.live") : status === "done" ? T("vote.badge.done") : T("vote.badge.upcoming");
  const sideCls = (id: number | undefined) =>
    "side" + (m.myChoice === id ? " picked" : "") + (m.decided && m.winnerId === id ? " win" : "")
    + (busy && m.myChoice === id ? " pending" : "") + (flash && m.myChoice === id ? " flash" : "");
  // 赛中不显示任何票数/得票率；结算后才公布绝对票数
  const numA = revealed ? String(m.votesA ?? 0) : "";
  const numB = revealed ? String(m.votesB ?? 0) : "";

  return (
    <div className={"match match--" + status + (ko ? " ko" : "")}>
      <div className={"mpill mpill--" + status}>{pill}</div>
      <div className="versus">
        <button type="button" className={sideCls(m.a?.id)} onClick={() => clickable && m.a && onVote(m.id, m.a.id)} disabled={!m.a}>
          <Avatar c={m.a} lg />
          <span className="nm" lang={srcLang(m.a, lang)}>{label(m.a, lang)}</span>{sub(m.a, lang) && <span className="cn">{sub(m.a, lang)}</span>}
          <span className="v num">{numA}</span>
          {m.decided && m.winnerId === m.a?.id && <span className="adv-tag">{T("match.advance")}</span>}
        </button>
        <div className="vs">VS</div>
        <button type="button" className={sideCls(m.b?.id)} onClick={() => clickable && m.b && onVote(m.id, m.b.id)} disabled={!m.b}>
          <Avatar c={m.b} lg />
          <span className="nm" lang={srcLang(m.b, lang)}>{label(m.b, lang)}</span>{sub(m.b, lang) && <span className="cn">{sub(m.b, lang)}</span>}
          <span className="v num">{numB}</span>
          {m.decided && m.winnerId === m.b?.id && <span className="adv-tag">{T("match.advance")}</span>}
        </button>
      </div>
      <div className={"share" + (revealed ? "" : " hidden")}><div className="a" style={{ width: pa + "%" }} /><div className="b" style={{ width: 100 - pa + "%" }} /></div>
      <div className="match-foot">
        {revealed ? <span className="rate-note">{T("match.settled")}</span> : null}
      </div>
      {!compact && m.a && m.b && <Comments matchId={m.id} count={m.commentN} lang={lang} />}
    </div>
  );
}

function Comments({ matchId, count, lang }: { matchId: number; count: number; lang: Lang }) {
  const T = (k: string, p?: Record<string, string | number>) => t(lang, k, p);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<any[] | null>(null);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const fetchList = async () => {
    try { const r = await api(`/api/comments?matchupId=${matchId}`); const j = await r.json(); setList(j.comments || []); }
    catch { setList([]); }
  };
  const toggle = () => { const nx = !open; setOpen(nx); if (nx && list === null) fetchList(); };
  const send = async () => {
    const t = text.trim(); if (!t || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await api("/api/comments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ matchupId: matchId, text: t, name: name.trim() }) });
      const j = await r.json();
      if (j.error) setErr(j.error);
      else { setText(""); await fetchList(); }
    } catch { setErr(T("cmt.sendFail")); }
    finally { setBusy(false); }
  };

  return (
    <div className="cmts">
      <button type="button" className="cmt-toggle" onClick={toggle}>💬 {open ? T("cmt.collapse") : T("cmt.open") + (count ? " " + count : "")}</button>
      {open && (
        <div className="cmt-body">
          <div className="cmt-post">
            <input className="cmt-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={T("cmt.name")} maxLength={24} />
            <div className="cmt-row">
              <input className="cmt-text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={T("cmt.text")} maxLength={300} />
              <button className="btn solid" onClick={send} disabled={busy || !text.trim()}>{T("cmt.send")}</button>
            </div>
            {err && <div className="hint" style={{ color: "var(--rose-deep)" }}>{err}</div>}
          </div>
          {list === null ? <div className="hint">{T("cmt.loading")}</div>
            : list.length === 0 ? <div className="hint">{T("cmt.empty")}</div>
            : <ul className="cmt-list">{list.map((c) => (
                <li key={c.id}><span className="cmt-who">{c.name || T("cmt.anon")}</span><span className="cmt-t">{c.text}</span></li>
              ))}</ul>}
        </div>
      )}
    </div>
  );
}

function BracketCell({ m, active, onOpen, lang }: { m: Match; active: boolean; onOpen: () => void; lang: Lang }) {
  const revealed = m.decided;
  const cell = (c: Slim | null, id: number | undefined, right: boolean) => {
    const num = revealed ? (right ? m.votesB ?? 0 : m.votesA ?? 0) : m.rateA == null ? "" : (right ? 100 - m.rateA : m.rateA) + "%";
    const win = m.decided && m.winnerId === id;
    const pick = m.myChoice === id;
    return (
      <div className={"bside" + (win ? " win" : "") + (pick ? " picked" : "")}>
        <Avatar c={c} />
        <span className="bnm">{label(c, lang)}</span>
        <span className="bnum num">{num}</span>
      </div>
    );
  };
  return (
    <button type="button" className={"bcell" + (active ? " active" : "")} onClick={onOpen}>
      {cell(m.a, m.a?.id, false)}
      {cell(m.b, m.b?.id, true)}
    </button>
  );
}
