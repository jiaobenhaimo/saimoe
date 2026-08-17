"use client";

import { useCallback, useEffect, useState } from "react";
import { groupLabel } from "@/lib/i18n";

/** epoch → <input type="datetime-local"> 需要的本地时间字符串。 */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtAbs(ms?: number | null): string {
  if (!ms) return "";
  try { return new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

export default function Admin() {
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authErr, setAuthErr] = useState("");
  const [tallies, setTallies] = useState<any>(null);
  const [state, setState] = useState<any>(null);
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [obs, setObs] = useState<any>(null);

  const [title, setTitle] = useState("SML 2026");
  const [size, setSize] = useState(48);

  // schedule inputs
  const [nomLocal, setNomLocal] = useState("");
  const [rHours, setRHours] = useState(24);
  const [pDays, setPDays] = useState(2);
  const [nUserLimit, setNUserLimit] = useState(0);
  const [nMinVotes, setNMinVotes] = useState(0);
  const [perRound, setPerRound] = useState(0);
  const [roundDays, setRoundDays] = useState(0);
  const [dayCap, setDayCap] = useState(4);
  const [groupSize, setGroupSize] = useState(6);
  const [groupMode, setGroupMode] = useState<"approval" | "rr">("approval");
  const [groupsPerDay, setGroupsPerDay] = useState(2);
  const [thirdPlace, setThirdPlace] = useState(true);
  const [dlHours, setDlHours] = useState(24);
  const [paceDays, setPaceDays] = useState(1);
  const [paceHours, setPaceHours] = useState(24);

  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editShort, setEditShort] = useState("");
  const [editTitleEn, setEditTitleEn] = useState(""); const [editTitleJa, setEditTitleJa] = useState("");
  const [editDescEn, setEditDescEn] = useState(""); const [editDescJa, setEditDescJa] = useState("");
  const [editShortEn, setEditShortEn] = useState(""); const [editShortJa, setEditShortJa] = useState("");
  // pool row: inline edit + two-step merge
  const [editId, setEditId] = useState<number | null>(null);
  const [eName, setEName] = useState(""); const [eCn, setECn] = useState(""); const [eEn, setEEn] = useState(""); const [eImg, setEImg] = useState(""); const [eSub, setESub] = useState("");
  const [eSubJa, setESubJa] = useState(""); const [eSubEn, setESubEn] = useState("");
  const [mergeFrom, setMergeFrom] = useState<{ id: number; name: string } | null>(null);
  // item3：黑名单（每行一条）
  const [blkTags, setBlkTags] = useState("");
  // 停投（维护）
  const [fzFrom, setFzFrom] = useState("");
  const [fzTo, setFzTo] = useState("");
  const [fzNote, setFzNote] = useState("");
  const [blkSubs, setBlkSubs] = useState("");

  // 网络诊断
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<any>(null);

  // 公众号推送文案
  const [remind, setRemind] = useState<{ mass: string; pull: string } | null>(null);
  const [remindBusy, setRemindBusy] = useState(false);
  const [copied, setCopied] = useState("");

  // 调试模式
  const [dbgOn, setDbgOn] = useState(false);
  const [dbgBusy, setDbgBusy] = useState(false);
  const [dbgLog, setDbgLog] = useState<string[]>([]);
  const [dbgCount, setDbgCount] = useState(8);
  const [dbgVoters, setDbgVoters] = useState(30);
  useEffect(() => { if (!authed || !token) return; fetch("/api/admin/debug", { headers: { "x-admin-token": token } }).then((r) => r.json()).then((j) => setDbgOn(!!j.enabled)).catch(() => {}); }, [authed, token]);
  const dbgAct = async (action: string, extra: Record<string, unknown> = {}) => {
    if (dbgBusy) return;
    setDbgBusy(true); localStorage.setItem("adminToken", token); setMsg(null); setDbgLog([]);
    try {
      const r = await fetch("/api/admin/debug", { method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": token }, body: JSON.stringify({ action, ...extra }) });
      const j = await r.json();
      if (!r.ok) setMsg({ t: j.error || "调试失败", ok: false });
      else { if (j.log) setDbgLog(j.log); setMsg({ t: j.log ? `模拟完成（${j.log.length} 步）` : `调试 ${action} 完成`, ok: true }); }
      await load();
    } finally { setDbgBusy(false); }
  };

  useEffect(() => { setToken(localStorage.getItem("adminToken") || ""); }, []);

  const load = useCallback(async () => {
    const r = await fetch("/api/state", { cache: "no-store" });
    setState(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (busy) return; // prevent double-submit
    setBusy(true);
    localStorage.setItem("adminToken", token);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ action, ...extra }),
      });
      const j = await r.json();
      if (!r.ok) setMsg({ t: j.error || "操作失败", ok: false });
      else setMsg({ t: j.message || "已执行：" + action, ok: true });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const loadObs = useCallback(async () => {
    const tk = token || localStorage.getItem("adminToken") || "";
    if (!tk) return;
    try {
      const r = await fetch("/api/admin/observe", { headers: { "x-admin-token": tk }, cache: "no-store" });
      if (r.ok) { const j = await r.json(); setObs(j); setTallies(j.tallies || null); setAuthed(true); }
    } catch {}
  }, [token]);
  useEffect(() => { if (token) loadObs(); }, [token, loadObs]);
  // token gate: only reveal the console once the token is verified against an admin endpoint (item 2)
  const unlock = useCallback(async () => {
    const tk = token.trim(); setAuthErr("");
    if (!tk) { setAuthErr("请输入令牌。"); return; }
    try {
      const r = await fetch("/api/admin/observe", { headers: { "x-admin-token": tk }, cache: "no-store" });
      if (r.ok) { localStorage.setItem("adminToken", tk); setAuthed(true); const j = await r.json(); setObs(j); setTallies(j.tallies || null); }
      else setAuthErr("令牌不正确。");
    } catch { setAuthErr("校验失败，请重试。"); }
  }, [token]);
  const invalidate = async (by: string, key: string) => { await act("invalidate_votes", { by, key }); await loadObs(); };

  // 可疑票溯源：点开看这个设备/IP/身份的每一票投给了谁，再勾选要作废的
  const [probe, setProbe] = useState<{ by: string; key: string; keyShort: string; votes: any[] } | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const openProbe = async (f: { by: string; key: string; keyShort: string }) => {
    setProbeBusy(true); setPicked(new Set());
    try {
      const tk = token || localStorage.getItem("adminToken") || "";
      const r = await fetch(`/api/admin/observe?by=${encodeURIComponent(f.by)}&key=${encodeURIComponent(f.key)}`,
        { headers: { "x-admin-token": tk }, cache: "no-store" });
      const j = await r.json();
      setProbe({ by: f.by, key: f.key, keyShort: f.keyShort, votes: Array.isArray(j?.votes) ? j.votes : [] });
    } catch { setMsg({ t: "读取失败，请重试。", ok: false }); }
    finally { setProbeBusy(false); }
  };
  const togglePick = (id: number) => setPicked((s2) => { const n = new Set(s2); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const invalidatePicked = async () => {
    if (!picked.size) return;
    if (!confirm(`确认作废选中的 ${picked.size} 张票？不可撤销。若相关轮次已结算，请随后「按当前票数重算本轮」。`)) return;
    const ids = [...picked];
    await act("invalidate_vote_ids", { ids });
    setPicked(new Set());
    if (probe) await openProbe(probe); // 重新拉取：已作废的会消失
    await loadObs();
  };

  /** 角色信息编辑器：提名池和「资料缺失盘点」共用同一套表单，就地展开、就地保存。 */
  const openEditor = (v: { id: number; name?: string; nameCn?: string; nameEn?: string; image?: string; subjectName?: string; subjectNameJa?: string; subjectNameEn?: string }) => {
    setEditId(v.id);
    setEName(v.name || ""); setECn(v.nameCn || ""); setEEn(v.nameEn || "");
    setEImg(v.image || ""); setESub(v.subjectName || "");
    setESubJa(v.subjectNameJa || ""); setESubEn(v.subjectNameEn || "");
  };
  const saveEditor = async (candidateId: number) => {
    await act("edit_candidate", { candidateId, name: eName, nameCn: eCn, nameEn: eEn, image: eImg, subjectName: eSub, subjectNameJa: eSubJa, subjectNameEn: eSubEn });
    setEditId(null);
    await loadObs(); // 让「资料缺失盘点」立刻反映补齐结果
  };
  const renderEditor = (candidateId: number) => (
    <div style={{ flex: 1, display: "grid", gap: 6, minWidth: 0 }}>
      <div className="row3">
        <div className="field"><label>中文名</label><input value={eCn} onChange={(e) => setECn(e.target.value)} /></div>
        <div className="field"><label>原名（日文）</label><input value={eName} onChange={(e) => setEName(e.target.value)} /></div>
        <div className="field"><label>EN</label><input value={eEn} onChange={(e) => setEEn(e.target.value)} /></div>
      </div>
      <div className="row3">
        <div className="field" style={{ gridColumn: "span 2" }}><label>图片 URL</label><input value={eImg} onChange={(e) => setEImg(e.target.value)} /></div>
        <div className="field"><label>所属作品（中文）</label><input value={eSub} onChange={(e) => setESub(e.target.value)} /></div>
      </div>
      <div className="row3">
        <div className="field"><label>作品 JA</label><input value={eSubJa} onChange={(e) => setESubJa(e.target.value)} placeholder="日本語タイトル" /></div>
        <div className="field"><label>作品 EN</label><input value={eSubEn} onChange={(e) => setESubEn(e.target.value)} placeholder="English title" /></div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn solid" disabled={busy} onClick={() => saveEditor(candidateId)}>保存</button>
        <button className="btn" onClick={() => setEditId(null)}>取消</button>
      </div>
    </div>
  );

  const loadRemind = async () => {
    if (remindBusy) return;
    setRemindBusy(true); localStorage.setItem("adminToken", token); setMsg(null);
    try {
      const r = await fetch("/api/admin/reminder", { headers: { "x-admin-token": token }, cache: "no-store" });
      const j = await r.json();
      if (!r.ok) { setMsg({ t: j.error || "生成失败", ok: false }); return; }
      setRemind({ mass: j.mass, pull: j.pull });
    } finally { setRemindBusy(false); }
  };
  const copy = async (text: string, which: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(which); setTimeout(() => setCopied(""), 1500); } catch {}
  };

  const ping = async () => {
    setPinging(true); setPingResult(null);
    try {
      const r = await fetch("/api/diag", { headers: { "x-admin-token": token }, cache: "no-store" });
      setPingResult(await r.json());
    } catch (e: any) {
      setPingResult({ error: "请求失败：" + (e?.message || e) });
    } finally { setPinging(false); }
  };

  const downloadExport = async (format: "json" | "csv") => {
    try {
      const r = await fetch(`/api/admin/export?format=${format}`, { headers: { "x-admin-token": token } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setMsg({ t: j.error || "导出失败", ok: false }); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `saimoe-${comp?.id ?? "results"}.${format === "csv" ? "csv" : "json"}`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setMsg({ t: "导出失败：" + (e?.message || e), ok: false });
    }
  };

  const comp = state?.competition;
  const phase = comp?.phase;
  const [active, setActive] = useState<string>("overview");
  const phaseLabel = phase === "nomination" ? "提名期" : phase === "group" ? "小组赛" : phase === "playoff" ? "加赛" : phase === "knockout" ? "淘汰赛" : phase === "finished" ? "已结束" : "未开赛";
  const NAV: [string, string][] = [
    ["overview", "📊 概览"],
    ["advance", "🎬 赛程推进"],
    ["setup", "🗓️ 赛制设置"],
    ["content", "🗂️ 内容管理"],
    ...(state?.voteGate?.on ? ([["wx", "📣 公众号"]] as [string, string][]) : []),
    ["monitor", "🛡️ 监控"],
    ["danger", "⚠️ 危险区"],
  ];

  useEffect(() => {
    if (comp) { setEditTitle(comp.title || ""); setEditDesc(comp.description || ""); setEditShort(comp.shortName || ""); setEditTitleEn(comp.titleEn || ""); setEditTitleJa(comp.titleJa || ""); setEditDescEn(comp.descEn || ""); setEditDescJa(comp.descJa || ""); setEditShortEn(comp.shortEn || ""); setEditShortJa(comp.shortJa || ""); setNUserLimit(comp.nomUserLimit || 0); setNMinVotes(comp.nomMinVotes || 0); setBlkTags((comp.blockedTags || []).join("\n")); setBlkSubs((comp.blockedSubjects || []).join("\n"));
      setFzFrom(comp.freeze?.from ? toLocalInput(comp.freeze.from) : ""); setFzTo(comp.freeze?.to ? toLocalInput(comp.freeze.to) : ""); setFzNote(comp.freeze?.note || "");
      // 赛制与节奏回填（此前不回填：重开后台后表单是默认值，再保存一次就把已设好的节奏覆盖成 0，
      // 公开赛程于是全变「时间待定」）
      if (comp.autoSize) setSize(comp.autoSize); else if (comp.targetSize) setSize(comp.targetSize);
      if (comp.groupSize) setGroupSize(comp.groupSize);
      if (comp.groupMode) setGroupMode(comp.groupMode);
      if (comp.groupsPerDay) setGroupsPerDay(comp.groupsPerDay);
      if (comp.groupPerRound) setPerRound(comp.groupPerRound);
      setRoundDays(comp.groupRoundDays ?? 0);
      setDayCap(comp.groupDayCap ?? 4);
      setRHours(comp.roundHours ?? 24);
      if (comp.postponeDays != null) setPDays(comp.postponeDays);
      if (comp.thirdPlace != null) setThirdPlace(!!comp.thirdPlace);
      setNomLocal(comp.nomEndsAt ? toLocalInput(comp.nomEndsAt) : ""); }
  }, [comp?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const estGroups = Math.max(1, Math.floor(size / Math.max(2, groupSize)));
  const estKo = (() => { let p = 1; const t = 2 * estGroups; while (p < t) p <<= 1; return Math.max(2, p); })();

  const sched = state?.schedule;
  const fmtR = (a?: number | null, b?: number | null) => (a && b ? `${fmtAbs(a)} → ${fmtAbs(b)}` : b ? `→ ${fmtAbs(b)}` : a ? `${fmtAbs(a)} →` : "时间待定");
  const nm = (x: any) => (x ? (x.nameCn || x.name) : "?");
  const koZh = (label: string) => (label === "bronze" ? "季军战" : label === "final" ? "决赛" : label === "semi" ? "半决赛" : label === "quarter" ? "1/4 决赛" : label.startsWith("top:") ? `${label.slice(4)} 强` : label);
  const winnerOf = (m: any) => (m.winnerId == null ? null : m.a?.id === m.winnerId ? m.a : m.b?.id === m.winnerId ? m.b : null);

  return (
    <main className="wrap admin">
      <div className="eyebrow">Admin</div>
      <h1 className="title" style={{ fontSize: 30 }}>赛事控制台</h1>
      <p className="subtitle">推进比赛阶段。所有操作需要管理员令牌（环境变量 <code>ADMIN_TOKEN</code>）。</p>

      <div className="admin-cards">

      {/* ── 接入（先验证令牌才显示控制台）── */}
      <div className="card">
        <div className="field"><label>管理员令牌</label>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") unlock(); }} placeholder="ADMIN_TOKEN" /></div>
        {!authed && <button className="btn solid" onClick={unlock} style={{ marginTop: 8 }}>解锁控制台</button>}
        {authed && <p className="hint" style={{ margin: "8px 0 0", color: "var(--ok)" }}>✓ 已解锁</p>}
        {authErr && <p className="hint" style={{ margin: "8px 0 0", color: "var(--danger)" }}>{authErr}</p>}
      </div>

      {!authed ? (
        <div className="card"><p className="hint" style={{ margin: 0 }}>输入管理员令牌并解锁后，这里会显示全部管理选项。</p></div>
      ) : (<>
      <div className="admin-status">
        <div className="as-main">{comp ? <>《{comp.title}》 · <b>{phaseLabel}</b></> : "暂无比赛"}</div>
        {comp && phase === "nomination" && comp.nomEndsAt && <div className="as-sub">提名截止 {fmtAbs(comp.nomEndsAt)}</div>}
        {comp && phase === "group" && <div className="as-sub">第 {comp.groupMatchday}/{comp.groupMatchdayCount} 比赛日{comp.groupRoundEndsAt ? ` · ${fmtAbs(comp.groupRoundEndsAt)} 结算` : ""}</div>}
        {comp && phase === "knockout" && comp.koRoundEndsAt && <div className="as-sub">本轮 {fmtAbs(comp.koRoundEndsAt)} 推进</div>}
      </div>
      <div className="admin-shell">
        <nav className="admin-nav">
          {NAV.map(([k, label]) => (
            <button key={k} type="button" className={"admin-navbtn" + (active === k ? " on" : "")} onClick={() => setActive(k)}>{label}</button>
          ))}
        </nav>
        <div className="admin-work">

      {active === "overview" && (<>
      <div className="admin-section">📊 概览</div>
      <div className="card">
        <h3>当前状态</h3>
        {comp ? (
          <>
            <p style={{ margin: 0 }}>
              《{comp.title}》— 阶段：<b>{phase}</b>
              {comp.groupsCount ? ` · ${comp.groupsCount} 组 → ${comp.koTarget} 强` : ""}
              {comp.targetSize ? ` · 取前 ${comp.targetSize} 名` : ""}
            </p>
            {phase === "nomination" && comp.nomEndsAt && <p className="hint" style={{ marginBottom: 0 }}>已定时：提名将于 <b>{fmtAbs(comp.nomEndsAt)}</b> 截止；人数不足顺延 {comp.postponeDays} 天。</p>}
            {phase === "group" && comp.groupRoundEndsAt && <p className="hint" style={{ marginBottom: 0 }}>小组赛第 <b>{comp.groupMatchday}/{comp.groupMatchdayCount}</b> 比赛日将于 <b>{fmtAbs(comp.groupRoundEndsAt)}</b> 自动结算。</p>}
            {phase === "knockout" && comp.koRoundEndsAt && <p className="hint" style={{ marginBottom: 0 }}>本轮将于 <b>{fmtAbs(comp.koRoundEndsAt)}</b> 自动推进。</p>}
          </>
        ) : <p style={{ margin: 0, color: "var(--muted)" }}>暂无比赛。</p>}
      </div>

      {/* ── 赛程推进（按阶段顺序） ── */}
      </>)}
      {active === "advance" && (<>
      <div className="admin-section">🎬 赛程推进</div>

      {comp && (
        <div className="card">
          <h3>停止投票（维护）{state?.competition?.freeze?.active && <span className="gstatus" style={{ color: "var(--danger)" }}>进行中</span>}</h3>
          <p className="hint">开启后用户无法投票/提名（接口一并拦截），方便你安心修数据。也可预约一个维护窗口，首页会提前公告。</p>
          <div className="row3">
            <div className="field"><label>维护开始（日期 + 时分，留空=不预约）</label>
              <input type="datetime-local" step={60} value={fzFrom} onChange={(e) => setFzFrom(e.target.value)} /></div>
            <div className="field"><label>自动恢复（日期 + 时分，留空=手动恢复）</label>
              <input type="datetime-local" step={60} value={fzTo} onChange={(e) => setFzTo(e.target.value)} /></div>
            <div className="field"><label>公告文案（可留空用默认）</label>
              <input value={fzNote} onChange={(e) => setFzNote(e.target.value)} placeholder="例如：系统维护中，暂停投票" /></div>
          </div>
          {(() => {
            const from = fzFrom ? new Date(fzFrom).getTime() : null;
            const to = fzTo ? new Date(fzTo).getTime() : null;
            if (to != null && from == null) return <p className="hint" style={{ color: "var(--danger)" }}>只填了「恢复时间」不会生效：预约维护必须填写开始时间。</p>;
            if (from != null && to != null && to <= from) return <p className="hint" style={{ color: "var(--danger)" }}>恢复时间早于或等于开始时间，这样的窗口永远不会触发，请修正。</p>;
            if (from != null) return <p className="hint">将于 <b>{fmtAbs(from)}</b> 起暂停投票{to != null ? <> ，<b>{fmtAbs(to)}</b> 自动恢复（约 {Math.round((to - from) / 60000)} 分钟）</> : "，需手动恢复"}。</p>;
            return null;
          })()}
          <button className={"btn" + (state?.competition?.freeze?.manual ? " danger solid" : " solid")} disabled={busy}
            onClick={() => act("set_freeze", { on: !state?.competition?.freeze?.manual, from: fzFrom ? new Date(fzFrom).getTime() : null, to: fzTo ? new Date(fzTo).getTime() : null, note: fzNote })}>
            {state?.competition?.freeze?.manual ? "恢复投票" : "立即停止投票"}
          </button>{" "}
          <button className="btn" disabled={busy}
            onClick={() => act("set_freeze", { on: state?.competition?.freeze?.manual ?? false, from: fzFrom ? new Date(fzFrom).getTime() : null, to: fzTo ? new Date(fzTo).getTime() : null, note: fzNote })}>仅保存预约</button>
          {state?.competition?.freeze?.from != null && (
            <p className="hint" style={{ marginTop: 10 }}>
              已预约维护：<b>{fmtAbs(state.competition.freeze.from)}</b>
              {state.competition.freeze.to != null ? <> 至 <b>{fmtAbs(state.competition.freeze.to)}</b></> : "（需手动恢复）"}
              {state.competition.freeze.upcoming ? "，尚未开始" : state.competition.freeze.active ? "，正在进行" : "，已过期"}
              {"　"}
              <a onClick={() => { if (!busy && confirm("移除这个维护计划？首页的维护公告会一并消失；若正处于维护中，投票会立即恢复。")) { act("clear_freeze_plan"); setFzFrom(""); setFzTo(""); setFzNote(""); } }}
                style={{ cursor: "pointer" }}>移除维护计划</a>
            </p>
          )}
        </div>
      )}

      {(!comp || phase === "finished") && (
        <div className="card">
          <h3>① 创建新一届</h3>
          <div className="field"><label>标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <button className="btn solid" disabled={busy} onClick={() => act("create", { title })}>创建比赛（进入提名阶段）</button>
        </div>
      )}

      {comp && (
        <div className="card wide">
          <h3>编辑比赛信息</h3>
          <div className="field"><label>比赛名称（中文）</label>
            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} /></div>
          <div className="row3">
            <div className="field"><label>名称 EN</label><input value={editTitleEn} onChange={(e) => setEditTitleEn(e.target.value)} placeholder="English title" /></div>
            <div className="field"><label>名称 JA</label><input value={editTitleJa} onChange={(e) => setEditTitleJa(e.target.value)} placeholder="日本語タイトル" /></div>
          </div>
          <div className="field"><label>简介 / 副标题（中文，可选）</label>
            <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
              placeholder="例如：2026 春季 · 由你决定最萌角色" /></div>
          <div className="row3">
            <div className="field"><label>简介 EN</label><input value={editDescEn} onChange={(e) => setEditDescEn(e.target.value)} /></div>
            <div className="field"><label>简介 JA</label><input value={editDescJa} onChange={(e) => setEditDescJa(e.target.value)} /></div>
          </div>
          <div className="field"><label>比赛简称（中文，可选，规则页等处代替「SML」）</label>
            <input value={editShort} onChange={(e) => setEditShort(e.target.value)}
              placeholder="例如：B萌、春季杯" /></div>
          <div className="row3">
            <div className="field"><label>简称 EN</label><input value={editShortEn} onChange={(e) => setEditShortEn(e.target.value)} /></div>
            <div className="field"><label>简称 JA</label><input value={editShortJa} onChange={(e) => setEditShortJa(e.target.value)} /></div>
          </div>
          <button className="btn solid" disabled={busy || !editTitle.trim()}
            onClick={() => act("update", { title: editTitle, description: editDesc, shortName: editShort, titleEn: editTitleEn, titleJa: editTitleJa, descEn: editDescEn, descJa: editDescJa, shortEn: editShortEn, shortJa: editShortJa })}>保存修改</button>
        </div>
      )}

      {phase === "nomination" && (
        <div className="card">
          <h3>提名约束</h3>
          <p className="hint">限制每人可提名的角色数，并设置进入小组赛的最低提名票门槛（填 0 表示不限）。</p>
          <div className="row3">
            <div className="field"><label>每人提名上限</label>
              <input type="number" min={0} value={nUserLimit} onChange={(e) => setNUserLimit(+e.target.value)} /></div>
            <div className="field"><label>最低提名票</label>
              <input type="number" min={0} value={nMinVotes} onChange={(e) => setNMinVotes(+e.target.value)} /></div>
            <div className="field"><label>&nbsp;</label>
              <button className="btn solid" disabled={busy} onClick={() => act("nom_rules", { userLimit: nUserLimit, minVotes: nMinVotes })}>保存约束</button></div>
          </div>
        </div>
      )}

      {phase === "nomination" && (
        <div className="card">
          <h3>② 赛制与分组</h3>
          <p className="hint">这套配置对「立即开始」和「预约定时开赛」都生效——预约后会存下来，自动开赛时按此执行，并在下方「赛程预览」和规则页显示计划。</p>
          <div className="row3">
            <div className="field"><label>晋级人数（取前 N，含并列）</label>
              <input type="number" min={4} value={size} onChange={(e) => setSize(+e.target.value)} /></div>
            <div className="field"><label>每组人数</label>
              <input type="number" min={2} value={groupSize} onChange={(e) => setGroupSize(+e.target.value)} /></div>
          </div>
          <div className="row3">
            <div className="field"><label>小组赛玩法</label>
              <select value={groupMode} onChange={(e) => setGroupMode(e.target.value as any)}>
                <option value="approval">投票晋级（每人组内 2 票，取前二）</option>
                <option value="rr">循环赛（两两 1v1 对决）</option>
              </select></div>
            {groupMode === "approval"
              ? <div className="field"><label>每个比赛日开放几个组</label>
                  <input type="number" min={1} value={groupsPerDay} onChange={(e) => setGroupsPerDay(+e.target.value)} /></div>
              : <div className="field"><label>每组每轮场数（0=自动）</label>
                  <input type="number" min={0} value={perRound} onChange={(e) => setPerRound(+e.target.value)} /></div>}
            <div className="field"><label>每比赛日天数（0=手动）</label>
              <input type="number" min={0} value={roundDays} onChange={(e) => setRoundDays(+e.target.value)} /></div>
          </div>
          <div className="row3">
            {groupMode === "rr" && <div className="field"><label>每比赛日最多对局数（0=无限制）</label>
              <input type="number" min={0} value={dayCap} onChange={(e) => setDayCap(+e.target.value)} /></div>}
            <div className="field"><label>每轮淘汰赛（小时，0=手动）</label>
              <input type="number" min={0} value={rHours} onChange={(e) => setRHours(+e.target.value)} /></div>
          </div>
          {(roundDays === 0 || rHours === 0) && (
            <p className="hint" style={{ color: "var(--danger)" }}>
              注意：{roundDays === 0 ? "「每比赛日天数」为 0" : ""}{roundDays === 0 && rHours === 0 ? "、" : ""}{rHours === 0 ? "「每轮淘汰赛小时」为 0" : ""}
              ，表示该阶段靠你手动推进，公开赛程里对应的时间会显示「时间待定」。要让规则页展示完整日期，请填入天数/小时。
            </p>
          )}
          <p className="hint">约 <b>{estGroups}</b> 个 {groupSize} 人组（余数补进弱组成 {groupSize + 1} 人组），各组前 2 → <b>{estKo}</b> 强淘汰赛。{groupMode === "approval" ? `每人每组最多投 2 票，每天开放 ${groupsPerDay} 个组。` : "组内两两对战，按胜场取前二。"}</p>
          <label className="chk"><input type="checkbox" checked={thirdPlace} onChange={(e) => setThirdPlace(e.target.checked)} /> 进行季军战（半决赛两位败者加打一场定第三名）</label>
          <hr className="sep" />

          <h3 style={{ fontSize: 15 }}>立即开始</h3>
          <button className="btn solid" disabled={busy || size < 4}
            onClick={() => act("start_groups", { size, groupSize, mode: groupMode, groupsPerDay, thirdPlace, perRound, roundDays, dayCap })}>立即结束提名 → 开小组赛（前 {size} 名 → 约 {estGroups} 组 → {estKo} 强）</button>

          <hr className="sep" />
          <h3 style={{ fontSize: 15 }}>预约定时开赛</h3>
          <p className="hint">到提名截止时间自动用上面的配置开小组赛；若届时提名人数不足 {size}，自动顺延若干天（后续赛程随之顺延）。</p>
          <div className="row3">
            <div className="field" style={{ gridColumn: "span 2" }}><label>提名截止时间</label>
              <input type="datetime-local" value={nomLocal} onChange={(e) => setNomLocal(e.target.value)} /></div>
            <div className="field"><label>人数不足顺延（天）</label>
              <input type="number" min={1} value={pDays} onChange={(e) => setPDays(+e.target.value)} /></div>
          </div>
          <button className="btn solid" disabled={busy || size < 4 || !nomLocal}
            onClick={() => act("schedule", { nomEndsAt: nomLocal ? new Date(nomLocal).getTime() : 0, size, groupSize, mode: groupMode, groupsPerDay, thirdPlace, roundHours: rHours, groupPerRound: perRound, groupRoundDays: roundDays, dayCap, postponeDays: pDays })}>
            预约定时赛程
          </button>
          {comp.nomEndsAt
            ? <p className="hint">已预约（截止 {fmtAbs(comp.nomEndsAt)}）.<a onClick={() => act("unschedule")}>取消预约</a></p>
            : <p className="hint">尚未预约定时开赛。</p>}
        </div>
      )}

      {phase === "group" && (
        <div className="card">
          <h3>③ 小组赛比赛日</h3>
          <p className="hint">当前：第 <b>{comp.groupMatchday}/{comp.groupMatchdayCount}</b> 比赛日{comp.groupRoundEndsAt ? `（截止 ${fmtAbs(comp.groupRoundEndsAt)}）` : ""}；每组每轮 {comp.groupPerRound || "自动"} 场；每比赛日最多 {comp.groupDayCap === 0 ? "无限制" : (comp.groupDayCap || 4)} 场。</p>
          <button className="btn solid" disabled={busy} onClick={() => act("advance_group")}>结算本比赛日 → 下一比赛日</button>
          <hr className="sep" />
          <p className="hint">或直接结束整个小组赛（结算所有剩余比赛日并生成淘汰赛）：</p>
          <button className="btn" disabled={busy} onClick={() => act("start_knockout")}>结算小组赛 → 生成淘汰赛</button>
        </div>
      )}

      {phase === "playoff" && (
        <div className="card">
          <h3>③½ 第三名加赛</h3>
          <p className="hint">{state.playoff?.contenders ?? "?"} 名并列者进行循环赛，争夺最后 <b>{state.playoff?.slots ?? "?"}</b> 个晋级名额{comp.groupRoundEndsAt ? `（截止 ${fmtAbs(comp.groupRoundEndsAt)}）` : ""}.</p>
          <button className="btn solid" disabled={busy} onClick={() => act("resolve_playoff")}>结算加赛 → 生成淘汰赛</button>
        </div>
      )}

      {phase === "knockout" && (
        <div className="card">
          <h3>④ 推进淘汰赛一轮</h3>
          <p className="hint">按当前票数结算本轮，生成下一轮；打到只剩 1 人时产生冠军。{comp.koRoundEndsAt ? "（已定时，也可在此手动提前）" : ""}</p>
          <button className="btn solid" disabled={busy} onClick={() => act("advance")}>结算本轮 → 下一轮 / 决出冠军</button>
        </div>
      )}

      </>)}
      {active === "setup" && (<>
      {/* ── 赛程设置与预览 ── */}
      {comp && (<div className="admin-section">🗓️ 赛程设置与预览</div>)}

      {comp && phase !== "finished" && (
        <div className="card">
          <h3>赛程时间控制</h3>
          <p className="hint">
            直接设定 / 延长 / 清除<b>本阶段</b>（{phase === "nomination" ? "提名" : phase === "group" ? `小组赛第 ${comp.groupMatchday}/${comp.groupMatchdayCount} 比赛日` : "本淘汰轮"}）的截止时间，到点自动推进。
            当前截止：{(phase === "nomination" ? comp.nomEndsAt : phase === "group" ? comp.groupRoundEndsAt : comp.koRoundEndsAt) ? fmtAbs(phase === "nomination" ? comp.nomEndsAt : phase === "group" ? comp.groupRoundEndsAt : comp.koRoundEndsAt) : "无"}.
          </p>
          <div className="row3">
            <div className="field"><label>本阶段还剩（小时）</label>
              <input type="number" min={0} step={0.5} value={dlHours} onChange={(e) => setDlHours(+e.target.value)} /></div>
            <div className="field"><label>&nbsp;</label>
              <button className="btn solid" disabled={busy} onClick={() => act("set_deadline", { hours: dlHours })}>设定截止</button></div>
            <div className="field"><label>&nbsp;</label>
              <button className="btn" disabled={busy} onClick={() => act("set_deadline", { hours: 0 })}>清除截止</button></div>
          </div>
          {phase === "group" && (
            <div className="row3" style={{ marginTop: 8 }}>
              <div className="field"><label>后续每比赛日天数</label>
                <input type="number" min={0} step={0.5} value={paceDays} onChange={(e) => setPaceDays(+e.target.value)} /></div>
              <div className="field"><label>&nbsp;</label>
                <button className="btn" disabled={busy} onClick={() => act("set_pace", { groupRoundDays: paceDays })}>更新后续节奏</button></div>
              <div className="field"><label>&nbsp;</label><span className="hint">影响之后每个比赛日的自动截止</span></div>
            </div>
          )}
          {phase === "knockout" && (
            <div className="row3" style={{ marginTop: 8 }}>
              <div className="field"><label>后续每轮小时</label>
                <input type="number" min={0} value={paceHours} onChange={(e) => setPaceHours(+e.target.value)} /></div>
              <div className="field"><label>&nbsp;</label>
                <button className="btn" disabled={busy} onClick={() => act("set_pace", { roundHours: paceHours })}>更新后续节奏</button></div>
              <div className="field"><label>&nbsp;</label><span className="hint">影响之后每轮的自动截止</span></div>
            </div>
          )}
          {(phase === "nomination" || phase === "group") && (
            <>
              <hr className="sep" />
              <p className="hint">淘汰赛节奏可在开始前预设：设定后，淘汰赛每一轮都会按此自动截止（当前预设：{comp.roundHours ? `${comp.roundHours} 小时/轮` : "未设定（手动推进）"}）。</p>
              <div className="row3">
                <div className="field"><label>淘汰赛每轮时长（小时）</label>
                  <input type="number" min={0} value={paceHours} onChange={(e) => setPaceHours(+e.target.value)} /></div>
                <div className="field"><label>&nbsp;</label>
                  <button className="btn" disabled={busy} onClick={() => act("set_pace", { roundHours: paceHours })}>预设淘汰赛节奏</button></div>
                <div className="field"><label>&nbsp;</label><span className="hint">淘汰赛开始前即可设定</span></div>
              </div>
            </>
          )}
        </div>
      )}

      {comp && sched?.planned && (
        <div className="card">
          <h3>🗓️ 赛程预览（计划）</h3>
          <p className="hint">已预约的赛制与节奏。分组对阵要等提名结束抽签后才生成，所以这里只显示计划结构与节奏，不含具体对阵。</p>
          <p className="rules-p"><b>取前 {sched.targetSize} 名 → 约 {sched.groups} 个 {sched.groupSize} 人组 → {sched.koTarget} 强淘汰赛</b><br />各组前 2 + 各组最优第三名晋级淘汰赛。</p>
          <ul className="sched-list">
            <li><div className="sched-when">提名截止<span className="sched-time">{sched.plan?.nomEndsAt ? fmtAbs(sched.plan.nomEndsAt) : "未预约"}</span></div></li>
            <li><div className="sched-when">小组赛<span className="sched-time">{sched.plan?.groupRoundDays ? `每 ${sched.plan.groupRoundDays} 天一个比赛日` : "手动推进"} · 每日≤{sched.plan?.dayCap === 0 ? "无限制" : (sched.plan?.dayCap || 4)} 场</span></div></li>
            <li><div className="sched-when">淘汰赛<span className="sched-time">{sched.plan?.roundHours ? `每轮 ${sched.plan.roundHours} 小时` : "手动推进"}</span></div></li>
            <li><div className="sched-when">人数不足顺延<span className="sched-time">{sched.plan?.postponeDays || 1} 天</span></div></li>
          </ul>
        </div>
      )}

      {comp && sched?.known && (
        <div className="card">
          <h3>🗓️ 赛程预览</h3>
          <p className="hint">按当前排程与节奏推算的每个比赛日 / 每轮的时间与对阵（“时间待定”= 未设定节奏；淘汰赛未来轮对阵取决于上一轮结果）。此预览与「赛制介绍」页对外展示的内容一致。</p>
          {sched.group?.length > 0 && (<>
            <h4 className="sched-h">小组赛</h4>
            <ul className="sched-list">
              {sched.group.map((d: any) => (
                <li key={"g" + d.matchday} className={d.current ? "cur" : ""}>
                  <div className="sched-when">第 {d.matchday}/{d.matchdayCount} 比赛日{d.current ? " · 进行中" : ""}<span className="sched-time">{fmtR(d.start, d.end)}</span></div>
                  <div className="sched-pairs">
                    {sched.mode === "approval"
                      ? (d.groups || []).map((g: any, i: number) => (
                        <span key={i} className="pair">{groupLabel(g.groupNo)} 组：{g.members.join("、")}</span>
                      ))
                      : d.matches.map((m: any, i: number) => (
                        <span key={i} className={"pair" + (m.decided ? " done" : "")}>{nm(m.a)} <i>vs</i> {nm(m.b)}{m.decided && winnerOf(m) ? <b> · {nm(winnerOf(m))} 晋级</b> : null}</span>
                      ))}
                  </div>
                </li>
              ))}
            </ul>
          </>)}
          {sched.knockout?.length > 0 && (<>
            <h4 className="sched-h">淘汰赛</h4>
            <ul className="sched-list">
              {sched.knockout.map((r: any, i: number) => (
                <li key={"k" + i}>
                  <div className="sched-when">{koZh(r.label)}<span className="sched-time">{fmtR(r.start, r.end)}</span></div>
                  <div className="sched-pairs">
                    {r.pending ? <span className="tbd">对阵待定（取决于上一轮结果）</span> : r.matches.map((m: any, j: number) => (
                      <span key={j} className={"pair" + (m.decided ? " done" : "")}>{nm(m.a)} <i>vs</i> {nm(m.b)}{m.decided && winnerOf(m) ? <b> · {nm(winnerOf(m))} 晋级</b> : null}</span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </>)}
        </div>
      )}

      </>)}
      {active === "wx" && (<>
      {/* ── 公众号 / 投票通道：仅当 .env 启用门禁（WX_VOTE_GATE）时出现 ── */}
      {state?.voteGate?.on && (<>
      <div className="admin-section">📣 公众号 / 投票通道</div>

      <div className="card">
        <h3>投票门禁 · 已由环境变量启用</h3>
        <p className="hint">
          门禁由 <code>WX_VOTE_GATE</code> 环境变量控制，当前为<b>开启</b>：只有从公众号「回复投票」拿到专属链接的用户能投票，直连网站的人只读；admin 始终用令牌进后台，不受影响。
          <br />需关闭请在部署环境移除 / 置空 <code>WX_VOTE_GATE</code> 后重新部署。请确认已配置 <code>WX_TOKEN</code> / <code>PUBLIC_BASE_URL</code> 并把 <code>/api/wx</code> 接入公众号。
        </p>
      </div>

      {comp && (
        <div className="card">
          <h3>本轮推送文案</h3>
          <p className="hint"><b>手动群发</b>：每天可在公众号后台群发 1 条，复制下面「群发」文案粘贴即可（群发是同一条发给所有人，无法带每人专属链接，故用「回复投票领链接」引导）。<b>拉取回复</b>：用户给公众号发消息时，自动回复这条（含该用户专属投票链接）——由服务器在被动回复时生成，下面是样例。</p>
          <button className="btn solid" disabled={remindBusy} onClick={loadRemind}>{remindBusy ? "生成中…" : "生成本轮推送文案"}</button>
          {remind && (
            <>
              <hr className="sep" />
              <div className="field"><label>群发文案（手动群发用） <a onClick={() => copy(remind.mass, "mass")} style={{ cursor: "pointer" }}>{copied === "mass" ? "已复制 ✓" : "复制"}</a></label>
                <pre className="ping-result">{remind.mass}</pre></div>
              <div className="field"><label>拉取回复样例（被动回复用） <a onClick={() => copy(remind.pull, "pull")} style={{ cursor: "pointer" }}>{copied === "pull" ? "已复制 ✓" : "复制"}</a></label>
                <pre className="ping-result">{remind.pull}</pre></div>
            </>
          )}
        </div>
      )}
      </>)}

      </>)}
      {active === "content" && (<>
      {/* ── 内容管理 ── */}
      {comp && (<div className="admin-section">🗂️ 内容管理</div>)}

      {comp && obs?.gaps && (
        <div className="card wide">
          <h3>资料缺失盘点 {obs.gaps.rows.length > 0
            ? <span className="gstatus" style={{ color: "var(--danger)" }}>{obs.gaps.rows.length} 个角色待补</span>
            : <span className="gstatus" style={{ color: "var(--ok)" }}>全部完整</span>}</h3>
          <p className="hint">开赛前把缺的补齐：三语名字缺失时前端会按「日语 → 中文 → 英语」回退，缺照片则显示首字母占位。<b>按提名票数从高到低排列</b>，人气角色优先补。点「编辑」就地修改，保存后本行自动消失。{" "}<a onClick={loadObs}>刷新</a></p>
          <div className="tally-grid">
            {([["中文名", obs.gaps.counts.nameZh], ["日文名", obs.gaps.counts.nameJa], ["英文名", obs.gaps.counts.nameEn],
               ["作品中文", obs.gaps.counts.subjectZh], ["作品日文", obs.gaps.counts.subjectJa], ["作品英文", obs.gaps.counts.subjectEn],
               ["照片", obs.gaps.counts.image]] as [string, number][]).map(([k, v]) => (
              <div className="tally-col" key={k}>
                <div className="tally-h">{k}</div>
                <div className={"tally-row" + (v > 0 ? " adv" : "")}><span className="nm">缺失</span><span className="v num">{v}</span></div>
              </div>
            ))}
          </div>
          {obs.gaps.rows.length > 0 && (
            <details className="done-fold" style={{ marginTop: 12 }}>
              <summary>逐个查看（{obs.gaps.rows.length}）· 缺得最多的排在前面</summary>
              <div className="fold-body">
                <div className="pool-admin">
                  {obs.gaps.rows.map((r: any) => (
                    <div className="prow" key={r.id}>
                      {editId === r.id ? renderEditor(r.id) : (
                        <>
                          <div className="meta"><div className="nm">{r.label}</div><div className="sub">{r.bgmId} · 缺 {r.missing.join("、")}{r.mergedInto ? ` · 已并入「${r.mergedInto}」（不参赛）` : ""}</div></div>
                          <div className="votecell num"><div className="c">{r.votes}</div><div className="l">提名</div></div>
                          <button className="btn" disabled={busy} onClick={() => openEditor(r)}>编辑</button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </details>
          )}
        </div>
      )}

      {comp && (
        <div className="card wide">
          <h3>提名黑名单</h3>
          <p className="hint">命中黑名单的角色无法进入提名池（已在池中的不会自动移除，需手动删）。每行一条，作品按名称「包含」匹配，标签需完全相同。</p>
          <div className="row3">
            <div className="field"><label>作品黑名单（按名称包含匹配）</label>
              <textarea rows={4} value={blkSubs} onChange={(e) => setBlkSubs(e.target.value)} placeholder={"例如：\n某部不参赛的作品\n另一部"} /></div>
            <div className="field"><label>标签黑名单（作品标签，需完全相同）</label>
              <textarea rows={4} value={blkTags} onChange={(e) => setBlkTags(e.target.value)} placeholder={"例如：\n里番\n国产"} /></div>
          </div>
          <button className="btn solid" disabled={busy}
            onClick={() => act("set_blocklist", { subjects: blkSubs.split("\n"), tags: blkTags.split("\n") })}>保存黑名单</button>
        </div>
      )}

      {phase === "nomination" && state?.nomination && (
        <div className="card wide">
          <h3>管理提名池</h3>
          <p className="hint">编辑角色信息、把重复/跨版本角色合并，或移除误加角色。<b>合并不会删除角色</b>：被并入的角色仍留在池中、仍可投票、单独显示，但票数汇总到上级角色（同一人投了组内多个只算一票），排名与抽签只算上级。移除会连同其票一起删除，无法撤销。</p>
          {mergeFrom && (
            <div className="gate-banner" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>正在合并「<b>{mergeFrom.name}</b>」→ 点选目标角色的「并入此」</span>
              <button className="btn" onClick={() => setMergeFrom(null)}>取消合并</button>
            </div>
          )}
          {state.nomination.pool.length === 0 ? <p className="hint">暂无提名。</p> : (
            <div className="pool-admin">
              {state.nomination.pool.map((p: any) => (
                <div className="prow" key={p.id}>
                  {editId === p.id ? (
                    renderEditor(p.id)
                  ) : (
                    <>
                      <div className="meta"><div className="nm">{p.nameCn || p.name}</div>{p.nameCn && p.nameCn !== p.name && <div className="sub">{p.name}</div>}</div>
                      <div className="votecell num"><div className="c">{p.votes}</div><div className="l">提名</div></div>
                      {mergeFrom && mergeFrom.id !== p.id ? (
                        <button className="btn solid" disabled={busy} onClick={() => { if (confirm(`把「${mergeFrom.name}」并入「${p.nameCn || p.name}」？\n\n前者不会被删除，仍可投票并单独显示，但票数会汇总计入后者。`)) { act("merge_candidate", { fromId: mergeFrom.id, toId: p.id }); setMergeFrom(null); } }}>并入此</button>
                      ) : mergeFrom && mergeFrom.id === p.id ? (
                        <span className="sub" style={{ alignSelf: "center" }}>合并源</span>
                      ) : (
                        <>
                          <button className="btn" disabled={busy} onClick={() => openEditor(p)}>编辑</button>
                          <button className="btn" disabled={busy} onClick={() => setMergeFrom({ id: p.id, name: p.nameCn || p.name })}>合并</button>
                        </>
                      )}
                      <button className="btn" disabled={busy || !!mergeFrom} onClick={() => { if (confirm(`确认移除「${p.nameCn || p.name}」？`)) act("remove_candidate", { candidateId: p.id }); }}>移除</button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {probe && (
            <div className="probe">
              <div className="probe-head">
                <b>{probe.keyShort}</b> 的投票明细 · 共 {probe.votes.length} 票{picked.size > 0 ? ` · 已选 ${picked.size}` : ""}
                <span className="probe-actions">
                  <button className="btn" onClick={() => setPicked(new Set(probe.votes.map((v: any) => v.id)))}>全选</button>
                  <button className="btn" onClick={() => setPicked(new Set())}>清空</button>
                  <button className="btn danger solid" disabled={busy || picked.size === 0} onClick={invalidatePicked}>作废选中（{picked.size}）</button>
                  <button className="btn" onClick={() => { setProbe(null); setPicked(new Set()); }}>关闭</button>
                </span>
              </div>
              {probe.votes.length === 0 ? <p className="hint">这个身份在本届没有留下票（可能已被作废）。</p> : (
                <div className="probe-list">
                  {probe.votes.map((v: any) => (
                    <label className={"probe-row" + (picked.has(v.id) ? " on" : "")} key={v.id}>
                      <input type="checkbox" checked={picked.has(v.id)} onChange={() => togglePick(v.id)} />
                      <span className={"flagtag flag-" + (v.kind === "match" ? "burst" : v.kind === "approval" ? "device" : "ip")}>
                        {v.kind === "nomination" ? "提名" : v.kind === "approval" ? "票选" : "对战"}
                      </span>
                      <span className="pv-target">投给 <b>{v.target}</b></span>
                      <span className="pv-detail">{v.detail}</span>
                      <span className="pv-at num">{v.at ? fmtAbs(v.at) : "—"}</span>
                    </label>
                  ))}
                </div>
              )}
              <p className="hint">身份：{probe.by === "bucket" ? "设备指纹" : probe.by === "ip" ? "IP" : "投票人"} · 勾选后只作废选中的这几票，其余保留。</p>
            </div>
          )}
        </div>
      )}

      {(phase === "group" || phase === "playoff" || phase === "knockout" || phase === "finished") && (
        <div className="card">
          <h3>撤销 / 重算</h3>
          <p className="hint">撤回上一步阶段推进（回到上一阶段 / 上一轮），或按当前票数重算当前轮。谨慎使用。</p>
          <button className="btn" disabled={busy} onClick={() => act("undo")}>撤回上一步</button>{" "}
          <button className="btn" disabled={busy} onClick={() => act("resettle")}>按当前票数重算本轮</button>
        </div>
      )}

      {comp && (
        <div className="card">
          <h3>导出结果</h3>
          <p className="hint">导出当前比赛的赛况数据（JSON 为完整结构，CSV 为扁平表格）。</p>
          <button className="btn" disabled={busy} onClick={() => downloadExport("json")}>导出 JSON</button>{" "}
          <button className="btn" disabled={busy} onClick={() => downloadExport("csv")}>导出 CSV</button>
        </div>
      )}

      </>)}
      {active === "monitor" && (<>
      {/* ── 监控与诊断 ── */}
      <div className="admin-section">🛡️ 监控与诊断</div>

      {comp && tallies && tallies.mode !== "none" && (phase === "group" || phase === "knockout" || phase === "playoff") && (
        <div className="card wide">
          <h3>实时票数（管理员）</h3>
          <p className="hint">仅管理员可见的当前票数（用户页赛中不公布）。{" "}<a onClick={loadObs}>刷新</a></p>
          {tallies.mode === "approval" ? (
            <div className="tally-grid">
              {(tallies.groups || []).map((g: any) => (
                <div className="tally-col" key={g.group}>
                  <div className="tally-h">{groupLabel(g.group)} 组</div>
                  {g.rows.map((r: any, i: number) => (
                    <div className={"tally-row" + (i < 2 ? " adv" : "")} key={r.name}><span className="nm">{r.name}</span><span className="v num">{r.votes}</span></div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="pool-admin">
              {(tallies.matches || []).map((m: any, i: number) => (
                <div className="prow" key={i}>
                  <div className="meta"><div className="nm">{m.a} <span className="vs-mini">vs</span> {m.b}</div><div className="sub">{m.label}{m.decided ? " · 已结算" : ""}</div></div>
                  <div className="votecell num"><div className="c">{m.va} : {m.vb}</div></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {comp && obs && (
        <div className="card wide">
          <h3>异常投票看板</h3>
          <p className="hint">
            共 {obs.totals?.votes ?? 0} 票（含元数据 {obs.totals?.withMeta ?? 0}）、{obs.totals?.matches ?? 0} 场对局。
            阈值：同设备 ≥{obs.thresholds?.DEVICE_MIN} 身份 · 同 IP ≥{obs.thresholds?.IP_MIN} 身份 · {Math.round((obs.thresholds?.BURST_WINDOW_MS || 0) / 1000)}s 内 ≥{obs.thresholds?.BURST_MIN} 票 · 覆盖 ≥{Math.round((obs.thresholds?.COVERAGE_PCT || 0) * 100)}%。
            {" "}<a onClick={loadObs}>刷新</a>
          </p>
          {(!obs.flags || obs.flags.length === 0) ? (
            <p className="hint">未发现可疑模式 👍</p>
          ) : (
            <div className="pool-admin">
              {obs.flags.map((f: any) => (
                <div className="prow" key={f.type + ":" + f.key}>
                  <span className={"flagtag flag-" + f.type}>{f.type === "device" ? "设备" : f.type === "ip" ? "IP" : f.type === "burst" ? "爆发" : "覆盖"}</span>
                  <div className="meta"><div className="nm">{f.keyShort}{f.identities ? ` · ${f.identities} 身份` : ""} · {f.votes} 票</div><div className="sub">{f.detail}</div></div>
                  <button className="btn" disabled={busy || probeBusy} onClick={() => openProbe(f)}>查看</button>
                  <button className="btn danger" disabled={busy} onClick={() => { if (confirm(`确认作废「${f.keyShort}」的全部票？不可撤销。若该轮已结算，请随后「按当前票数重算本轮」。`)) invalidate(f.by, f.key); }}>全部作废</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {comp && obs && (
        <div className="card">
          <h3>操作审计日志</h3>
          <p className="hint">最近的管理操作（最多 200 条，倒序）。{" "}<a onClick={loadObs}>刷新</a></p>
          {(!obs.audit || obs.audit.length === 0) ? (
            <p className="hint">暂无记录。</p>
          ) : (
            <ul className="audit">
              {obs.audit.map((a: any) => (
                <li key={a.id}><span className="au-ts">{fmtAbs(a.ts)}</span><span className="au-sum">{a.summary}</span>{a.phase ? <span className="au-phase">{a.phase}</span> : null}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {dbgOn && (
        <div className="card">
          <h3>服务端诊断</h3>
          <p className="hint">查看服务端环境：Node 版本、数据/备份目录、以及对 <code>api.bgm.tv</code> 的系统 DNS 解析（仅解析，不发起连接）。搜索/导入已改为浏览器端直连 Bangumi，服务端不再访问 Bangumi；若在线搜索失败，请在浏览器控制台排查前端请求。</p>
          <button className="btn solid" disabled={busy || pinging} onClick={ping}>{pinging ? "检查中…" : "运行诊断"}</button>
          {pingResult && <pre className="ping-result">{JSON.stringify(pingResult, null, 2)}</pre>}
        </div>
      )}

      {dbgOn && (
        <div className="card" style={{ borderColor: "var(--gold)", background: "#fffdf5" }}>
          <h3>🐞 调试模式</h3>
          <p className="hint">用假数据在几分钟内验证整条赛程。<b>仅在 DEBUG_MODE=true 时可用，上线前请关闭。</b>会新建一场比赛（成为当前比赛）。</p>
          <div className="row3">
            <div className="field"><label>角色/参赛数</label>
              <input type="number" min={2} value={dbgCount} onChange={(e) => setDbgCount(+e.target.value)} /></div>
            <div className="field"><label>模拟投票人数</label>
              <input type="number" min={1} value={dbgVoters} onChange={(e) => setDbgVoters(+e.target.value)} /></div>
            <div className="field"><label>&nbsp;</label>
              <button className="btn solid" disabled={dbgBusy} onClick={() => dbgAct("simulate", { count: dbgCount, groups: 2, advance: 2, voters: dbgVoters })}>一键模拟整届</button></div>
          </div>
          <hr className="sep" />
          <p className="hint">或分步来（配合上面的赛程按钮）：</p>
          <div className="btnrow">
            <button className="btn" disabled={dbgBusy} onClick={() => dbgAct("seed", { count: dbgCount })}>① 造 {dbgCount} 个测试角色</button>
            <button className="btn" disabled={dbgBusy} onClick={() => dbgAct("nominate", { votes: dbgCount * 20 })}>② 灌提名票</button>
            <button className="btn" disabled={dbgBusy} onClick={() => dbgAct("vote", { voters: dbgVoters })}>③ 给当前开放对战灌票</button>
          </div>
          {dbgLog.length > 0 && <pre className="ping-result">{dbgLog.join("\n")}</pre>}
        </div>
      )}

      </>)}
      {active === "danger" && (<>
      {/* ── 危险区 ── */}
      <div className="admin-section">⚠️ 危险区</div>
      <div className="card">
        <h3>危险操作</h3>
        <p className="hint">删除当前比赛及其全部数据，无法撤销。</p>
        <button className="btn danger" disabled={busy} onClick={() => { if (confirm("确认删除当前比赛？")) act("reset"); }}>重置 / 删除当前比赛</button>
      </div>

      </>)}
      </div>
      </div>
      </>)}
      </div>

      {msg && <div className={"msg " + (msg.ok ? "ok" : "err")}>{msg.t}</div>}
      <div className="foot"><a href="/">← 返回投票页</a>
        <div className="foot-oss">本站由开源项目 <a href="https://github.com/jiaobenhaimo/saimoe" target="_blank" rel="noopener noreferrer">jiaobenhaimo/saimoe</a> 驱动，以 GPL-3.0 许可发布，欢迎取用与改造。</div>
      </div>
    </main>
  );
}
