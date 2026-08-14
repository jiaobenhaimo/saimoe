"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t, roundLabelT, LANGS, type Lang } from "@/lib/i18n";

type Slim = { id: number; name: string; nameCn: string | null; nameEn?: string | null; image: string | null; subjectName?: string | null };
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
function api(path: string, opts: RequestInit = {}) {
  const headers = new Headers(opts.headers);
  if (FP) headers.set("x-fp", FP);
  if (DB_BUCKET) headers.set("x-db", DB_BUCKET);
  return fetch(path, { ...opts, headers, cache: "no-store" });
}

// 浏览器直接加载 Bangumi 图片(用户网络可达,不经服务端);统一转成方形 grid 尺寸。
function imgSrc(url?: string | null): string {
  if (!url) return "";
  return url.replace(/(\/pic\/crt\/)[a-z](\/)/, "$1g$2");
}

function initials(n?: string) { return n?.trim()?.[0]?.toUpperCase() || "?"; }

function Avatar({ c, lg }: { c: Slim | null; lg?: boolean }) {
  const [broke, setBroke] = useState(false);
  if (!c) return null;
  const src = imgSrc(c.image);
  if (!src || broke) return <div className={"av-ph" + (lg ? " lg" : "")}>{initials(c.name)}</div>;
  return <img className={"av" + (lg ? " lg" : "")} src={src} alt={c.name} referrerPolicy="no-referrer" loading="lazy" onError={() => setBroke(true)} />;
}

// 主名按 UI 语言:中文→中文名,英文→英文名,日文→原名;缺失时回退原(日文)名。
const primaryName = (c: Slim, lang: Lang) => lang === "zh" ? (c.nameCn || c.name) : lang === "en" ? (c.nameEn || c.name) : c.name;
const label = (c: Slim | null, lang: Lang) => (c ? primaryName(c, lang) : "—");
// 副行:非日文 UI 时补显日文(原)名(若与主名不同),并附作品名。
const sub = (c: Slim | null, lang: Lang) => {
  if (!c) return "";
  const primary = primaryName(c, lang);
  const parts: string[] = [];
  if (lang !== "ja" && c.name && c.name !== primary) parts.push(c.name);
  if (c.subjectName) parts.push(c.subjectName);
  return parts.join(" · ");
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
  const set = (l: Lang) => { setLang(l); try { localStorage.setItem("saimoe_lang", l); } catch {} };
  return [lang, set];
}

export default function Page() {
  const [state, setState] = useState<any>(null);
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

  // 角色搜索:v0 只有 POST /v0/search/characters。把它发成 CORS「简单请求」(text/plain)绕过预检;
  // 能否成功取决于 Bangumi 是否给 POST 附跨域头,失败则提示改用「搜作品名」导入。
  const search = async () => {
    const kw = q.trim(); if (!kw) return;
    setSearching(true); setSearchErr(""); setHits(null); setSubHits(null); setImportMsg("");
    try {
      const r = await fetch("https://api.bgm.tv/v0/search/characters?limit=20", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8", Accept: "application/json" },
        body: JSON.stringify({ keyword: kw }),
      });
      if (!r.ok) { setSearchErr(T("search.fail", { err: "HTTP " + r.status })); setHits([]); return; }
      const j = await r.json();
      const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.list) ? j.list : [];
      const seen = new Set<string>();
      const items = arr
        .filter((c: any) => c && c.name && (c.type == null || c.type === 1)) // 只留真正的角色(排除机体/舰船/组织团体)
        .map((c: any) => ({ bgmId: "c" + c.id, name: c.name, nameCn: "", nameEn: "", image: c.images?.grid || c.images?.medium || "" }))
        .filter((c: any) => !seen.has(c.bgmId) && (seen.add(c.bgmId), true));
      setHits(items);
      if (items.length === 0) setSearchErr(T("search.trysubject"));
    } catch { setSearchErr(T("search.fail", { err: "跨域被拦截,请改用搜作品名导入" })); setHits([]); }
    finally { setSearching(false); }
  };

  // 浏览器直接调 Bangumi 老接口 GET /search/subject(GET 支持跨域,无需代理/服务端)
  const searchSubjects = async () => {
    const kw = subQ.trim(); if (!kw) return;
    setSubSearching(true); setImportMsg(""); setSubHits(null); setHits(null); setSearchErr("");
    try {
      const r = await fetch(`https://api.bgm.tv/search/subject/${encodeURIComponent(kw)}?type=2&responseGroup=large&max_results=20`, { headers: { Accept: "application/json" } });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.includes("json")) { setImportMsg(T("subject.neterr")); setSubHits([]); return; }
      const j = await r.json();
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
        .map((x: any) => ({ subjectId: String(x.id), name: x.name || "", nameCn: x.name_cn || "", image: x.images?.grid || x.images?.common || "", year: String(x.air_date || "").slice(0, 4) }));
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
  // ── 日本产地软校验(方案 A):查 bangumi 作品 tag 是否含「日本」。返回 true/false/null(null=查不了,不阻断) ──
  const subjectHasJP = async (subjectId: string | number): Promise<boolean | null> => {
    try {
      const d = await (await fetch(`https://api.bgm.tv/v0/subjects/${encodeURIComponent(String(subjectId))}`, { headers: { Accept: "application/json" } })).json();
      const names: string[] = [
        ...((Array.isArray(d?.tags) ? d.tags : []).map((t: any) => (typeof t === "string" ? t : t?.name || ""))),
        ...((Array.isArray(d?.meta_tags) ? d.meta_tags : []).map((m: any) => (typeof m === "string" ? m : m?.name || ""))),
      ];
      return names.some((n) => n.includes("日本"));
    } catch { return null; }
  };
  const characterHasJP = async (rawId: string | number): Promise<boolean | null> => {
    try {
      const subs = await (await fetch(`https://api.bgm.tv/v0/characters/${encodeURIComponent(String(rawId))}/subjects`, { headers: { Accept: "application/json" } })).json();
      const ids = (Array.isArray(subs) ? subs : []).map((s: any) => s?.id).filter(Boolean).slice(0, 3);
      if (!ids.length) return null;
      for (const id of ids) { const jp = await subjectHasJP(id); if (jp) return true; }
      return false;
    } catch { return null; }
  };

  const nominate = async (h: any) => {
    setImportMsg("");
    await post({ batch: [{ bgmId: h.bgmId, name: h.name, nameCn: h.nameCn, image: h.image }] });
    await load();
    // 软校验:提交后再查产地,非日本(明确 false)才警告;查不了(null)不打扰
    const rawId = String(h.bgmId).replace(/^c/, "");
    if (rawId) { const jp = await characterHasJP(rawId); if (jp === false) setImportMsg(T("jp.warn.char")); }
  };
  // 浏览器直接调 GET(取角色列表 + 逐个补中文名),再交服务端存储;顺带记录作品名。
  const importSubject = async (subjectId: string, subjectName: string) => {
    setImportMsg(T("import.progress", { name: subjectName }));
    try {
      const r = await fetch(`https://api.bgm.tv/v0/subjects/${encodeURIComponent(subjectId)}/characters`, { headers: { Accept: "application/json" } });
      if (!r.ok) { setImportMsg(T("import.fail", { err: "HTTP " + r.status })); return; }
      const arr = await r.json();
      const chars = (Array.isArray(arr) ? arr : [])
        .filter((c: any) => c && c.name && (c.type == null || c.type === 1)) // 只留真正的角色
        .map((c: any) => ({ rawId: c.id, bgmId: "c" + c.id, name: c.name, nameCn: "", nameEn: "", image: c.images?.grid || c.images?.medium || "", subjectName }))
        .slice(0, 60);
      if (!chars.length) { setImportMsg(T("import.fail", { err: "no characters" })); return; }
      // 补中文名:逐个取角色详情 infobox 的「简体中文名」(小并发,尽力而为)
      for (let i = 0; i < chars.length; i += 6) {
        setImportMsg(T("import.progress", { name: `${subjectName}（${i}/${chars.length}）` }));
        await Promise.all(chars.slice(i, i + 6).map(async (ch: any) => {
          try {
            const d = await (await fetch(`https://api.bgm.tv/v0/characters/${ch.rawId}`, { headers: { Accept: "application/json" } })).json();
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
      const jp = await subjectHasJP(subjectId); // 方案 A:软校验,仅在明确非日本时追加提醒
      const warn = jp === false ? " " + T("jp.warn.subject") : "";
      setImportMsg((j?.error ? T("import.fail", { err: j.error }) : T("import.done", { name: subjectName, added: j?.added ?? 0, imported: chars.length })) + warn);
      await load();
    } catch (e: any) {
      setImportMsg(T("import.fail", { err: e?.message || "network" }));
    }
  };

  const canVote = !state?.voteGate?.on || !!state?.voteGate?.canVote;
  const nomVote = async (candidateId: number) => {
    setNomErr("");
    if (!canVote) { setNomErr(T("gate.readonly")); return; }
    const r = await api("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "nominate", candidateId }) });
    const j = await r.json().catch(() => ({}));
    if (j?.error) setNomErr(j.error);
    await load();
  };
  const nomRemove = async (candidateId: number) => {
    setNomErr("");
    const j = await post({ remove: candidateId });
    if (j?.error) setNomErr(j.error);
    await load();
  };
  const matchVote = async (matchupId: number, choiceId: number) => {
    if (!canVote) return; // gate on & no link session → read-only (banner explains)
    await api("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "match", matchupId, choiceId }) });
    await load();
  };
  const approvalVote = async (candidateId: number) => {
    if (!canVote) return;
    const r = await api("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "approval", candidateId }) });
    const j = await r.json().catch(() => ({}));
    if (j?.error) setNomErr(j.error);
    await load();
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
  // map the live phase onto one of the chips (playoff & finished ride under 淘汰赛)
  const currentKey = phase === "playoff" || phase === "finished" ? "knockout" : phase;
  const viewKey = (view && hasView[view]) ? view : currentKey;
  const showKey = viewKey === "finished" ? "knockout" : viewKey; // 冠军 chip shows the knockout section (champion + bracket)
  const viewingPast = viewKey !== currentKey;

  // matches open for voting RIGHT NOW (drives the "现在投票" panel), for the current phase only
  const openMatches: Match[] =
    phase === "group" ? (state?.group?.mode === "approval" ? [] : (state?.group?.groups ?? []).flatMap((g: any) => g.matchups ?? []).filter((m: Match) => m.live && !m.decided && m.a && m.b))
    : phase === "playoff" ? (state?.playoff?.matchups ?? []).filter((m: Match) => m.live && !m.decided && m.a && m.b)
    : phase === "knockout" ? (state?.knockout?.rounds ?? []).flatMap((r: any) => r.matchups).filter((m: Match) => !m.decided && m.a && m.b)
    : [];
  const openVoted = openMatches.filter((m) => m.myChoice != null).length;

  // 下一批对局(下一比赛日 / 下一轮的预告)
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
      {(linkErr || !canVote) && (
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
                  <button className="btn" onClick={() => importSubject(s.subjectId, s.nameCn || s.name)}>{T("nom.importAll")}</button>
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
                  <button className="btn" onClick={() => nominate(h)}>{T("nom.plus")}</button>
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
                  <div className="meta"><div className="nm">{label(p, lang)}</div><div className="sub">{sub(p, lang)}</div></div>
                  <div className="votecell num"><div className="c">{p.votes}</div><div className="l">{T("nom.voteLabel")}</div></div>
                  <button className={"btn" + (p.voted ? " solid" : "")} onClick={() => nomVote(p.id)}>{p.voted ? T("nom.voted") : T("nom.vote")}</button>
                  {p.mine && p.votes === 0 && <button className="btn ghost" onClick={() => nomRemove(p.id)}>{T("nom.remove")}</button>}
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
                <div className="meta"><div className="nm">{label(p, lang)}</div><div className="sub">{sub(p, lang)}</div></div>
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
          <div className="sec"><h2>{T("group.title")}</h2><div className="meta2">{comp.koTarget ? T("group.wc", { n: comp.koTarget }) : ""}</div></div>
          {state.group.matchdayCount > 1 && <div className="hint">{T("group.matchday", { d: state.group.matchday, n: state.group.matchdayCount })}</div>}
          <div className="groupwrap">
            {state.group.mode === "approval"
              ? state.group.groups.map((g: any) => {
                const inner = (
                  <>
                    <h3>{T("group.letter", { L: String.fromCharCode(65 + g.group) })}
                      <span className="gstatus">{g.open ? T("gb.open", { n: g.myPicks, max: state.group.perGroupVotes }) : g.closed ? T("gb.closed") : T("gb.upcoming")}</span></h3>
                    <ul className="ballot-list">
                      {g.members.map((m: any) => (
                        <li key={m.id} className={(m.mine ? "mine " : "") + (m.advancing ? "adv" : "")}>
                          <Avatar c={m} />
                          <div className="meta"><div className="nm">{label(m, lang)}</div>
                            {m.votes != null && <div className="sub">{m.votes} {T("gb.votes")}{m.advancing ? " · " + T("gb.adv") : ""}</div>}</div>
                          {g.open
                            ? <button className={"btn" + (m.mine ? " solid" : "")} disabled={!canVote} onClick={() => approvalVote(m.id)}>{m.mine ? T("gb.picked") : T("gb.pick")}</button>
                            : <span className="rankpill">{m.rank + 1}</span>}
                        </li>
                      ))}
                    </ul>
                  </>
                );
                // finished groups collapse by default; open / upcoming stay visible
                return g.closed && !g.open
                  ? <details className="group ballot done-fold" key={g.group}><summary>{T("fold.doneGroup", { L: String.fromCharCode(65 + g.group) })}</summary><div className="fold-body">{inner}</div></details>
                  : <div className={"group ballot" + (g.open ? " open" : "")} key={g.group}>{inner}</div>;
              })
              : state.group.groups.map((g: any) => {
                const liveMs = g.matchups.filter((m: Match) => !m.decided);
                const doneMs = g.matchups.filter((m: Match) => m.decided);
                return (
                  <div className="group" key={g.group}>
                    <h3>{T("group.letter", { L: String.fromCharCode(65 + g.group) })}</h3>
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
                    {liveMs.map((m: Match) => <MatchCard key={m.id} m={m} onVote={matchVote} lang={lang} />)}
                    {doneMs.length > 0 && (
                      <details className="done-fold">
                        <summary>{T("fold.doneMatches", { n: doneMs.length })}</summary>
                        <div className="fold-body">{doneMs.map((m: Match) => <MatchCard key={m.id} m={m} onVote={matchVote} lang={lang} />)}</div>
                      </details>
                    )}
                  </div>
                );
              })}
          </div>
        </>
      )}

      {/* ── THIRD-PLACE PLAYOFF (shown within the 淘汰赛 view) ── */}
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
              {state.playoff.matchups.map((m: Match) => <MatchCard key={m.id} m={m} onVote={matchVote} lang={lang} />)}
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

      <div className="foot">
        {T("dataFrom")}
      </div>
    </main>
  );
}

function MatchCard({ m, onVote, ko, lang, compact }: { m: Match; onVote: (mid: number, cid: number) => void; ko?: boolean; lang: Lang; compact?: boolean }) {
  const T = (k: string, p?: Record<string, string | number>) => t(lang, k, p);
  const revealed = m.decided;
  const pa = revealed && m.total ? ((m.votesA || 0) / m.total) * 100 : 50;
  const live = m.live ?? true;
  const clickable = live && !m.decided && m.a && m.b;
  const status: "live" | "upcoming" | "done" = m.decided ? "done" : (clickable ? "live" : "upcoming");
  const pill = status === "live" ? T("vote.badge.live") : status === "done" ? T("vote.badge.done") : T("vote.badge.upcoming");
  const sideCls = (id: number | undefined) =>
    "side" + (m.myChoice === id ? " picked" : "") + (m.decided && m.winnerId === id ? " win" : "");
  // 赛中不显示任何票数/得票率;结算后才公布绝对票数
  const numA = revealed ? String(m.votesA ?? 0) : "";
  const numB = revealed ? String(m.votesB ?? 0) : "";

  return (
    <div className={"match match--" + status + (ko ? " ko" : "")}>
      <div className={"mpill mpill--" + status}>{pill}</div>
      <div className="versus">
        <button type="button" className={sideCls(m.a?.id)} onClick={() => clickable && m.a && onVote(m.id, m.a.id)} disabled={!m.a}>
          <Avatar c={m.a} lg />
          <span className="nm">{label(m.a, lang)}</span>{sub(m.a, lang) && <span className="cn">{sub(m.a, lang)}</span>}
          <span className="v num">{numA}</span>
          {m.decided && m.winnerId === m.a?.id && <span className="adv-tag">{T("match.advance")}</span>}
        </button>
        <div className="vs">VS</div>
        <button type="button" className={sideCls(m.b?.id)} onClick={() => clickable && m.b && onVote(m.id, m.b.id)} disabled={!m.b}>
          <Avatar c={m.b} lg />
          <span className="nm">{label(m.b, lang)}</span>{sub(m.b, lang) && <span className="cn">{sub(m.b, lang)}</span>}
          <span className="v num">{numB}</span>
          {m.decided && m.winnerId === m.b?.id && <span className="adv-tag">{T("match.advance")}</span>}
        </button>
      </div>
      <div className={"share" + (revealed ? "" : " hidden")}><div className="a" style={{ width: pa + "%" }} /><div className="b" style={{ width: 100 - pa + "%" }} /></div>
      <div className="match-foot">
        <span className="rate-note">{revealed ? T("match.settled") : live ? T("match.rateNote") : T("match.upcoming")}</span>
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
