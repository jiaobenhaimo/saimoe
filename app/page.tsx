"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t, roundLabelT, LANGS, groupLabel, type Lang } from "@/lib/i18n";

type Slim = { id: number; name: string; nameCn: string | null; nameEn?: string | null; image: string | null; subjectName?: string | null; subjectNameJa?: string | null; subjectNameEn?: string | null; jpPending?: boolean };
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

// 注：以前这里有一套「浏览器直连 Bangumi ↔ 走本站代理」双通道赛跑的逻辑（firstOk / bgmJson）。
// 现在所有 Bangumi 访问都在服务端完成（lib/bgm.ts），浏览器只跟本站说话，双通道自然就不需要了 ——
// 也顺带去掉了「同一次搜索打两遍上游」这个会加速触发 Bangumi 限流的副作用。

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

/** 统一成方形 grid 尺寸并升到 https（老接口返回 http:// 链接，HTTPS 站点会按混合内容拦掉）。 */
function imgSrc(url?: string | null): string {
  if (!url) return "";
  let u = url.trim();
  if (u.startsWith("//")) u = "https:" + u;
  u = u.replace(/^http:\/\//i, "https://");
  return u.replace(/(\/pic\/crt\/)[a-z](\/)/, "$1g$2");
}
/** 头像统一走本站代理（服务端取一次并落盘缓存，见 /api/img）。 */
function imgProxy(url: string): string {
  return "/api/img?u=" + encodeURIComponent(url);
}

function initials(n?: string) { return n?.trim()?.[0]?.toUpperCase() || "?"; }

/**
 * 头像。**默认走本站代理**，直连图床只作为代理失败时的兜底 —— 与之前的顺序正好相反。
 *
 * 为什么反过来：一个 200 人的提名池就是 200 张图，以前每个访客都直接去 lain.bgm.tv 取，
 * 于是 ①访问不到图床的网络整页都是空白 ②图床防盗链会挡掉一部分 ③上游要承受
 * 「访客数 × 图片数」的请求量。改成先走 /api/img 后，服务端对每张图只取一次并落盘，
 * 之后所有人都是同源缓存命中，既快又稳。
 */
function Avatar({ c, lg }: { c: Slim | null; lg?: boolean }) {
  const [stage, setStage] = useState<0 | 1 | 2>(0); // 0=本站代理 1=直连兜底 2=放弃，用首字母
  if (!c) return null;
  const src = imgSrc(c.image);
  if (!src || stage === 2) return <div className={"av-ph" + (lg ? " lg" : "")}>{initials(c.name)}</div>;
  return <img className={"av" + (lg ? " lg" : "")} src={stage === 0 ? imgProxy(src) : src} alt={c.name}
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
  // 提名后要高亮的池内角色 id（配合 jumpToCandidate 用）
  const [flashCand, setFlashCand] = useState<number | null>(null);

  /** 点了「提名」之后把用户送到提名池里那一行：滚过去 + 短暂高亮。
   *  角色已经在池里时尤其重要 —— 只说「已经在池里了」等于让用户自己去几百行里翻。 */
  const jumpToCandidate = useCallback((candidateId: number) => {
    setFlashCand(candidateId);
    // 等一帧再滚：这一行可能是 load() 刚刷出来的，DOM 还没渲染
    requestAnimationFrame(() => {
      const el = document.getElementById("cand-" + candidateId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    setTimeout(() => setFlashCand((v) => (v === candidateId ? null : v)), 2600);
  }, []);

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

  // ── 提名相关的网络操作：全部改成「跟本站说一句话」──────────────────────────
  //
  // 以前这些都在浏览器里做：搜角色 → 逐个角色查详情补简体中文名 → 查关联作品 → 查作品
  // 标签判定产地。导入一部作品要跨境往返 1 + N + N 次（N 可以是 60），在大陆移动网络下
  // 经常走不完，用户看到的就是「转圈转到超时」。现在这些活都搬到服务端（lib/bgm.ts），
  // 那里离 Bangumi 更近、有全站共享的缓存、并且自己限制并发；浏览器一次点击只发一个请求。
  const search = async () => {
    const kw = q.trim(); if (!kw) return;
    setSearching(true); setSearchErr(""); setHits(null); setSubHits(null); setImportMsg("");
    try {
      const r = await fetchT("/api/bgm?kind=searchChars&q=" + encodeURIComponent(kw), { cache: "no-store" }, 20_000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.error) throw new Error(j?.error || "HTTP " + r.status);
      const hits2 = Array.isArray(j.hits) ? j.hits : [];
      setHits(hits2);
      // 产地过滤在服务端做完了，这里只把「隐藏了几个」告诉用户
      if (j.filtered > 0) setImportMsg(T("jp.filtered", { n: j.filtered }));
      if (hits2.length === 0) setSearchErr(T("search.trysubject"));
    } catch (e: any) {
      setSearchErr(T("search.fail", { err: e?.message || "网络不可达" }));
      setHits([]);
    } finally { setSearching(false); }
  };

  const searchSubjects = async () => {
    const kw = subQ.trim(); if (!kw) return;
    setSubSearching(true); setImportMsg(""); setSubHits(null); setHits(null); setSearchErr("");
    try {
      const r = await fetchT("/api/bgm?kind=searchSubjects&q=" + encodeURIComponent(kw), { cache: "no-store" }, 20_000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.error) throw new Error(j?.error || "HTTP " + r.status);
      // 黑名单仍在前端先滤一遍，纯粹是为了少点无效点击；真正把关在 /api/nominate
      setSubHits((Array.isArray(j.hits) ? j.hits : []).filter((x: any) => !blockedReason(x.nameCn || x.name, x.tags)));
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

  /** 「日本」标签判定结果 → 给用户的提示。null（查不到）时故意什么都不说：
   *  上游抖一下就警告用户「你提的角色可能不合规」是纯粹的噪音。 */
  const jpNote = (jp: boolean | null | undefined, subject: boolean): string =>
    jp === false ? " " + T(subject ? "jp.warn.subject" : "jp.warn.char") : "";

  /** 添加单个角色：只把 bangumi id 交给服务端，名字/头像/所属作品/产地判定都由服务端补齐。 */
  const nominate = async (h: any) => {
    setImportMsg("");
    const key = "a" + h.bgmId;
    if (nomPending.has(key)) return;
    setNomPending((s2) => new Set(s2).add(key));
    try {
      const j = await post({ addChar: h.bgmId });
      if (j?.error) { setImportMsg(j.error); return; }
      if (j?.duplicate) setImportMsg(T("nom.dupJump", { name: j.name || h.name }));
      else {
        settle(key, T("nom.plus"));
        // 明确非日本作品时才提示；提示语本身就说明「已提交，管理员会复核」
        setImportMsg(T("nom.added", { name: j?.name || h.name }) + jpNote(j?.jp, false));
      }
      // 先等池子刷新到位，再滚过去 —— 新加的角色在旧的 state 里还不存在，
      // 立刻滚只会找不到那个 DOM 节点（这正是「点了没反应」的来源）。
      await load();
      if (j?.candidateId) jumpToCandidate(j.candidateId);
      return;
    } catch { setImportMsg(T("net.slow")); }
    finally { setNomPending((s2) => { const n = new Set(s2); n.delete(key); return n; }); }
    void load(); // 后台刷新提名池
  };

  /** 导入整部作品：服务端取角色表 + 逐个补中文名 + 判产地，一次请求搞定。 */
  const importSubject = async (subjectId: string, subjectName: string, _subjectNameJa = "") => {
    const deny = blockedReason(subjectName);
    if (deny) { setImportMsg(deny); return; }
    setImportMsg(T("import.progress", { name: subjectName }));
    try {
      // 服务端要取几十个角色的详情（并发受限），比普通请求慢得多，所以给一个单独的长超时；
      // 但仍然必须有超时 —— 否则上游卡住时按钮会一直转，用户既看不到结果也无法重试。
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 90_000);
      let r: Response;
      try {
        r = await api("/api/nominate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ importSubject: subjectId, tags: [] }),
          signal: ac.signal,
        });
      } finally { clearTimeout(timer); }
      const j = await r.json().catch(() => ({}));
      if (j?.error) { setImportMsg(T("import.fail", { err: j.error })); return; }
      const skipped = j?.skipped ? " " + T("import.blocked", { n: j.skipped }) : "";
      setImportMsg(T("import.done", { name: j?.subjectName || subjectName, added: j?.added ?? 0, imported: j?.imported ?? 0 })
        + skipped + jpNote(j?.jp, true));
      await load();
    } catch (e: any) {
      setImportMsg(T("import.fail", { err: e?.message || "network" }));
    }
  };

  // 本轮封禁的提示语：有票被删说「N 张票被作废」，没票被删（票被保留、但身份仍封禁）
  // 说另一句，否则会出现「你有 0 张票被作废」这种既费解又像故障的文案。
  const blockedMsg = () => (state?.sanction?.count ?? 0) > 0
    ? T("warn.blocked", { n: state?.sanction?.count ?? 0 })
    : T("warn.blocked0");

  // 休赛期与维护冻结都会停投，但对用户是两件事：休赛期是赛程的正常一环（下一轮自动开始），
  // 维护是临时故障处理。文案分开，否则用户会以为网站出问题了。
  const onBreak = !!state?.competition?.onBreak?.active;
  const breakUntil: number | null = state?.competition?.onBreak?.until ?? null;

  const frozen = !!state?.competition?.freeze?.active;                                   // 维护中：谁都不能投
  const gated = !frozen && !onBreak && !state?.sanction?.blockedThisRound && !!state?.voteGate?.on && !state?.voteGate?.canVote;            // 只是缺公众号链接
  const blockedRound = !!state?.sanction?.blockedThisRound;                                // 本轮被作废过票 → 本轮禁投
  const canVote = !frozen && !onBreak && !blockedRound && (!state?.voteGate?.on || !!state?.voteGate?.canVote);
  const nomVote = async (candidateId: number) => {
    setNomErr("");
    if (!canVote) { setNomErr(onBreak ? T("break.now") : frozen ? (state?.competition?.freeze?.note || T("freeze.now")) : blockedRound ? blockedMsg() : T("gate.readonly")); return; }
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
      setVoteErr(onBreak ? T("break.now") : frozen ? (state?.competition?.freeze?.note || T("freeze.now")) : blockedRound ? blockedMsg() : T("gate.readonly"));
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
      {/* 休赛期公告。用中性配色，不用报错的红色 —— 这是赛程的正常一环，不是故障。 */}
      {onBreak && !state?.competition?.freeze?.active && (
        <div className="gate-banner">
          <b>{T("break.now")}</b>
          {breakUntil ? " · " + T("break.until", { to: fmtAbs(breakUntil, lang) }) : ""}
          {phase === "nomination" ? <><br />{T("break.nomHint")}</> : null}
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
      {state?.sanction?.count > 0 && (
        <div className="gate-banner" role="alert" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
          {state.sanction.blockedThisRound
            ? blockedMsg()
            : T("warn.sanction", { n: state.sanction.count })}
        </div>
      )}
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
                  {/* 副行放「所属作品」：一次搜索经常返回几个同名角色，只看角色名分不出哪个是要的那个。 */}
                  <div className="meta">
                    <div className="nm">{h.nameCn || h.name}</div>
                    <div className="sub">
                      {h.nameCn && h.nameCn !== h.name ? h.name : ""}
                      {(h.nameCn && h.nameCn !== h.name ? " · " : "") + (h.subjectName || h.subjectNameJa || T("nom.unknownSubject"))}
                    </div>
                  </div>
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
                <div className={"prow" + (flashCand === p.id ? " jumped" : "")} id={"cand-" + p.id} key={p.id}>
                  <div className="rankn num">{i + 1}</div>
                  <Avatar c={p} />
                  <div className="meta"><div className="nm" lang={srcLang(p, lang)}>{label(p, lang)}
                    {/* 待复核：服务端明确没查到「日本」标签的角色。与提名时那句「管理员会复核」对应，
                        让用户看得见自己提交的东西确实在队列里，而不是提示一闪而过就没了下文。 */}
                    {(p as any).jpPending && <span className="tag warn" title={T("jp.pending.hint")}>{T("jp.pending")}</span>}</div>
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
