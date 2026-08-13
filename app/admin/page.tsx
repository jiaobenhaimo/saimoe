"use client";

import { useCallback, useEffect, useState } from "react";

function fmtAbs(ms?: number | null): string {
  if (!ms) return "";
  try { return new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

export default function Admin() {
  const [token, setToken] = useState("");
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
  const [dlHours, setDlHours] = useState(24);
  const [paceDays, setPaceDays] = useState(1);
  const [paceHours, setPaceHours] = useState(24);

  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editShort, setEditShort] = useState("");

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
  useEffect(() => { fetch("/api/admin/debug").then((r) => r.json()).then((j) => setDbgOn(!!j.enabled)).catch(() => {}); }, []);
  const dbgAct = async (action: string, extra: Record<string, unknown> = {}) => {
    if (dbgBusy) return;
    setDbgBusy(true); localStorage.setItem("adminToken", token); setMsg(null); setDbgLog([]);
    try {
      const r = await fetch("/api/admin/debug", { method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": token }, body: JSON.stringify({ action, ...extra }) });
      const j = await r.json();
      if (!r.ok) setMsg({ t: j.error || "调试失败", ok: false });
      else { if (j.log) setDbgLog(j.log); setMsg({ t: j.log ? `模拟完成(${j.log.length} 步)` : `调试 ${action} 完成`, ok: true }); }
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
      if (r.ok) setObs(await r.json());
    } catch {}
  }, [token]);
  useEffect(() => { if (token) loadObs(); }, [token, loadObs]);
  const invalidate = async (by: string, key: string) => { await act("invalidate_votes", { by, key }); await loadObs(); };

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
      const r = await fetch("/api/diag", { cache: "no-store" });
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

  useEffect(() => {
    if (comp) { setEditTitle(comp.title || ""); setEditDesc(comp.description || ""); setEditShort(comp.shortName || ""); setNUserLimit(comp.nomUserLimit || 0); setNMinVotes(comp.nomMinVotes || 0); }
  }, [comp?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const estGroups = Math.max(1, Math.floor(size / Math.max(2, groupSize)));
  const estKo = (() => { let p = 1; const t = 2 * estGroups; while (p < t) p <<= 1; return Math.max(2, p); })();

  const sched = state?.schedule;
  const fmtR = (a?: number | null, b?: number | null) => (a && b ? `${fmtAbs(a)} → ${fmtAbs(b)}` : b ? `→ ${fmtAbs(b)}` : a ? `${fmtAbs(a)} →` : "时间待定");
  const nm = (x: any) => (x ? (x.nameCn || x.name) : "?");
  const koZh = (label: string) => (label === "final" ? "决赛" : label === "semi" ? "半决赛" : label === "quarter" ? "1/4 决赛" : label.startsWith("top:") ? `${label.slice(4)} 强` : label);
  const winnerOf = (m: any) => (m.winnerId == null ? null : m.a?.id === m.winnerId ? m.a : m.b?.id === m.winnerId ? m.b : null);

  return (
    <main className="wrap admin">
      <div className="eyebrow">Admin</div>
      <h1 className="title" style={{ fontSize: 30 }}>赛事控制台</h1>
      <p className="subtitle">推进比赛阶段。所有操作需要管理员令牌（环境变量 <code>ADMIN_TOKEN</code>)。</p>

      <div className="admin-cards">

      {/* ── 接入 ── */}
      <div className="card">
        <div className="field"><label>管理员令牌</label>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_TOKEN" /></div>
      </div>

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
      <div className="admin-section">🎬 赛程推进</div>

      {(!comp || phase === "finished") && (
        <div className="card">
          <h3>① 创建新一届</h3>
          <div className="field"><label>标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <button className="btn solid" disabled={busy} onClick={() => act("create", { title })}>创建比赛（进入提名阶段）</button>
        </div>
      )}

      {comp && (
        <div className="card">
          <h3>编辑比赛信息</h3>
          <div className="field"><label>比赛名称</label>
            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} /></div>
          <div className="field"><label>简介 / 副标题（可选，显示在投票页标题下方）</label>
            <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
              placeholder="例如：2026 春季 · 由你决定最萌角色" /></div>
          <div className="field"><label>比赛简称（可选，用于规则页等文字，代替「SML」）</label>
            <input value={editShort} onChange={(e) => setEditShort(e.target.value)}
              placeholder="例如：B萌、春季杯" /></div>
          <button className="btn solid" disabled={busy || !editTitle.trim()}
            onClick={() => act("update", { title: editTitle, description: editDesc, shortName: editShort })}>保存修改</button>
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
          <p className="hint">这套配置对「立即开始」和「预约定时开赛」都生效——预约后会存下来,自动开赛时按此执行,并在下方「赛程预览」和规则页显示计划。</p>
          <div className="row3">
            <div className="field"><label>晋级人数(取前 N,含并列)</label>
              <input type="number" min={4} value={size} onChange={(e) => setSize(+e.target.value)} /></div>
            <div className="field"><label>每组人数</label>
              <input type="number" min={2} value={groupSize} onChange={(e) => setGroupSize(+e.target.value)} /></div>
            <div className="field"><label>每比赛日最多对局数</label>
              <input type="number" min={1} value={dayCap} onChange={(e) => setDayCap(+e.target.value)} /></div>
          </div>
          <div className="row3">
            <div className="field"><label>小组赛玩法</label>
              <select value={groupMode} onChange={(e) => setGroupMode(e.target.value as any)}>
                <option value="approval">投票晋级(每人组内 2 票,取前二)</option>
                <option value="rr">循环赛(两两 1v1 对决)</option>
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
            {groupMode === "rr" && <div className="field"><label>每比赛日最多对局数</label>
              <input type="number" min={1} value={dayCap} onChange={(e) => setDayCap(+e.target.value)} /></div>}
            <div className="field"><label>每轮淘汰赛（小时,0=手动）</label>
              <input type="number" min={0} value={rHours} onChange={(e) => setRHours(+e.target.value)} /></div>
          </div>
          <p className="hint">约 <b>{estGroups}</b> 个 {groupSize} 人组(余数补进弱组成 {groupSize + 1} 人组),各组前 2 → <b>{estKo}</b> 强淘汰赛。{groupMode === "approval" ? `每人每组最多投 2 票,每天开放 ${groupsPerDay} 个组。` : "组内两两对战,按胜场取前二。"}</p>
          <hr className="sep" />

          <h3 style={{ fontSize: 15 }}>立即开始</h3>
          <button className="btn solid" disabled={busy || size < 4}
            onClick={() => act("start_groups", { size, groupSize, mode: groupMode, groupsPerDay, perRound, roundDays, dayCap })}>立即结束提名 → 开小组赛(前 {size} 名 → 约 {estGroups} 组 → {estKo} 强)</button>

          <hr className="sep" />
          <h3 style={{ fontSize: 15 }}>预约定时开赛</h3>
          <p className="hint">到提名截止时间自动用上面的配置开小组赛;若届时提名人数不足 {size},自动顺延若干天(后续赛程随之顺延)。</p>
          <div className="row3">
            <div className="field" style={{ gridColumn: "span 2" }}><label>提名截止时间</label>
              <input type="datetime-local" value={nomLocal} onChange={(e) => setNomLocal(e.target.value)} /></div>
            <div className="field"><label>人数不足顺延（天）</label>
              <input type="number" min={1} value={pDays} onChange={(e) => setPDays(+e.target.value)} /></div>
          </div>
          <button className="btn solid" disabled={busy || size < 4 || !nomLocal}
            onClick={() => act("schedule", { nomEndsAt: nomLocal ? new Date(nomLocal).getTime() : 0, size, groupSize, mode: groupMode, groupsPerDay, roundHours: rHours, groupPerRound: perRound, groupRoundDays: roundDays, dayCap, postponeDays: pDays })}>
            预约定时赛程
          </button>
          {comp.nomEndsAt
            ? <p className="hint">已预约(截止 {fmtAbs(comp.nomEndsAt)})。<a onClick={() => act("unschedule")}>取消预约</a></p>
            : <p className="hint">尚未预约定时开赛。</p>}
        </div>
      )}

      {phase === "group" && (
        <div className="card">
          <h3>③ 小组赛比赛日</h3>
          <p className="hint">当前：第 <b>{comp.groupMatchday}/{comp.groupMatchdayCount}</b> 比赛日{comp.groupRoundEndsAt ? `（截止 ${fmtAbs(comp.groupRoundEndsAt)}）` : ""}；每组每轮 {comp.groupPerRound || "自动"} 场；每比赛日最多 {comp.groupDayCap || 4} 场。</p>
          <button className="btn solid" disabled={busy} onClick={() => act("advance_group")}>结算本比赛日 → 下一比赛日</button>
          <hr className="sep" />
          <p className="hint">或直接结束整个小组赛（结算所有剩余比赛日并生成淘汰赛）：</p>
          <button className="btn" disabled={busy} onClick={() => act("start_knockout")}>结算小组赛 → 生成淘汰赛</button>
        </div>
      )}

      {phase === "playoff" && (
        <div className="card">
          <h3>③½ 第三名加赛</h3>
          <p className="hint">{state.playoff?.contenders ?? "?"} 名并列者进行循环赛,争夺最后 <b>{state.playoff?.slots ?? "?"}</b> 个晋级名额{comp.groupRoundEndsAt ? `(截止 ${fmtAbs(comp.groupRoundEndsAt)})` : ""}。</p>
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

      {/* ── 赛程设置与预览 ── */}
      {comp && (<div className="admin-section">🗓️ 赛程设置与预览</div>)}

      {comp && phase !== "finished" && (
        <div className="card">
          <h3>赛程时间控制</h3>
          <p className="hint">
            直接设定 / 延长 / 清除<b>本阶段</b>（{phase === "nomination" ? "提名" : phase === "group" ? `小组赛第 ${comp.groupMatchday}/${comp.groupMatchdayCount} 比赛日` : "本淘汰轮"}）的截止时间，到点自动推进。
            当前截止：{(phase === "nomination" ? comp.nomEndsAt : phase === "group" ? comp.groupRoundEndsAt : comp.koRoundEndsAt) ? fmtAbs(phase === "nomination" ? comp.nomEndsAt : phase === "group" ? comp.groupRoundEndsAt : comp.koRoundEndsAt) : "无"}。
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
              <p className="hint">淘汰赛节奏可在开始前预设：设定后,淘汰赛每一轮都会按此自动截止（当前预设：{comp.roundHours ? `${comp.roundHours} 小时/轮` : "未设定（手动推进）"}）。</p>
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
          <h3>🗓️ 赛程预览(计划)</h3>
          <p className="hint">已预约的赛制与节奏。分组对阵要等提名结束抽签后才生成,所以这里只显示计划结构与节奏,不含具体对阵。</p>
          <p className="rules-p"><b>取前 {sched.targetSize} 名 → 约 {sched.groups} 个 {sched.groupSize} 人组 → {sched.koTarget} 强淘汰赛</b><br />各组前 2 + 各组最优第三名晋级淘汰赛。</p>
          <ul className="sched-list">
            <li><div className="sched-when">提名截止<span className="sched-time">{sched.plan?.nomEndsAt ? fmtAbs(sched.plan.nomEndsAt) : "未预约"}</span></div></li>
            <li><div className="sched-when">小组赛<span className="sched-time">{sched.plan?.groupRoundDays ? `每 ${sched.plan.groupRoundDays} 天一个比赛日` : "手动推进"} · 每日≤{sched.plan?.dayCap || 4} 场</span></div></li>
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
                        <span key={i} className="pair">{String.fromCharCode(65 + g.groupNo)} 组:{g.members.join("、")}</span>
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

      {/* ── 公众号 / 投票通道 ── */}
      <div className="admin-section">📣 公众号 / 投票通道</div>

      <div className="card">
        <h3>投票门禁</h3>
        <p className="hint">
          默认<b>关闭</b>:任何人打开网站即可投票(按浏览器指纹尽力去重),<b>不需要微信</b>。
          开启后:只有从公众号「回复投票」拿到专属链接的用户能投票,直连网站的人只读;admin 始终用令牌进后台,不受影响。
          <br />开启前请确认已配置 <code>WX_TOKEN</code> / <code>PUBLIC_BASE_URL</code> 并把 <code>/api/wx</code> 接入公众号,否则用户拿不到链接会无法投票。
        </p>
        <p style={{ margin: "0 0 10px" }}>当前状态:<b style={{ color: state?.voteGate?.on ? "var(--rose-deep)" : "var(--muted)" }}>{state?.voteGate?.on ? "已开启(仅公众号链接可投)" : "已关闭(无需微信,人人可投)"}</b></p>
        <button className={"btn" + (state?.voteGate?.on ? "" : " solid")} disabled={busy || !token}
          onClick={() => act("set_wx_gate", { on: !state?.voteGate?.on })}>
          {state?.voteGate?.on ? "关闭门禁(改为人人可投)" : "开启门禁(改为仅公众号链接可投)"}
        </button>
      </div>

      {comp && (
        <div className="card">
          <h3>本轮推送文案</h3>
          <p className="hint"><b>手动群发</b>:每天可在公众号后台群发 1 条,复制下面「群发」文案粘贴即可(群发是同一条发给所有人,无法带每人专属链接,故用「回复投票领链接」引导)。<b>拉取回复</b>:用户给公众号发消息时,自动回复这条(含该用户专属投票链接)——由服务器在被动回复时生成,下面是样例。</p>
          <button className="btn solid" disabled={remindBusy} onClick={loadRemind}>{remindBusy ? "生成中…" : "生成本轮推送文案"}</button>
          {remind && (
            <>
              <hr className="sep" />
              <div className="field"><label>群发文案(手动群发用) <a onClick={() => copy(remind.mass, "mass")} style={{ cursor: "pointer" }}>{copied === "mass" ? "已复制 ✓" : "复制"}</a></label>
                <pre className="ping-result">{remind.mass}</pre></div>
              <div className="field"><label>拉取回复样例(被动回复用) <a onClick={() => copy(remind.pull, "pull")} style={{ cursor: "pointer" }}>{copied === "pull" ? "已复制 ✓" : "复制"}</a></label>
                <pre className="ping-result">{remind.pull}</pre></div>
            </>
          )}
        </div>
      )}

      {/* ── 内容管理 ── */}
      {comp && (<div className="admin-section">🗂️ 内容管理</div>)}

      {phase === "nomination" && state?.nomination && (
        <div className="card">
          <h3>管理提名池</h3>
          <p className="hint">移除误加 / 重复的角色，会连同其提名票一起删除，无法撤销。</p>
          {state.nomination.pool.length === 0 ? <p className="hint">暂无提名。</p> : (
            <div className="pool-admin">
              {state.nomination.pool.map((p: any) => (
                <div className="prow" key={p.id}>
                  <div className="meta"><div className="nm">{p.nameCn || p.name}</div>{p.nameCn && p.nameCn !== p.name && <div className="sub">{p.name}</div>}</div>
                  <div className="votecell num"><div className="c">{p.votes}</div><div className="l">提名</div></div>
                  <button className="btn" disabled={busy} onClick={() => { if (confirm(`确认移除「${p.nameCn || p.name}」？`)) act("remove_candidate", { candidateId: p.id }); }}>移除</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(phase === "group" || phase === "knockout" || phase === "finished") && (
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

      {/* ── 监控与诊断 ── */}
      <div className="admin-section">🛡️ 监控与诊断</div>

      {comp && obs && (
        <div className="card">
          <h3>异常投票看板</h3>
          <p className="hint">
            共 {obs.totals?.votes ?? 0} 票(含元数据 {obs.totals?.withMeta ?? 0})、{obs.totals?.matches ?? 0} 场对局。
            阈值:同设备 ≥{obs.thresholds?.DEVICE_MIN} 身份 · 同 IP ≥{obs.thresholds?.IP_MIN} 身份 · {Math.round((obs.thresholds?.BURST_WINDOW_MS || 0) / 1000)}s 内 ≥{obs.thresholds?.BURST_MIN} 票 · 覆盖 ≥{Math.round((obs.thresholds?.COVERAGE_PCT || 0) * 100)}%。
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
                  <button className="btn" disabled={busy} onClick={() => { if (confirm(`确认作废「${f.keyShort}」的全部票?不可撤销。若该轮已结算,请随后「按当前票数重算本轮」。`)) invalidate(f.by, f.key); }}>作废</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {comp && obs && (
        <div className="card">
          <h3>操作审计日志</h3>
          <p className="hint">最近的管理操作(最多 200 条,倒序)。{" "}<a onClick={loadObs}>刷新</a></p>
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

      <div className="card">
        <h3>服务端诊断</h3>
        <p className="hint">查看服务端环境:Node 版本、数据/备份目录、以及对 <code>api.bgm.tv</code> 的系统 DNS 解析(仅解析,不发起连接)。搜索/导入已改为浏览器端直连 Bangumi,服务端不再访问 Bangumi;若在线搜索失败,请在浏览器控制台排查前端请求。</p>
        <button className="btn solid" disabled={busy || pinging} onClick={ping}>{pinging ? "检查中…" : "运行诊断"}</button>
        {pingResult && <pre className="ping-result">{JSON.stringify(pingResult, null, 2)}</pre>}
      </div>

      {dbgOn && (
        <div className="card" style={{ borderColor: "var(--gold)", background: "#fffdf5" }}>
          <h3>🐞 调试模式</h3>
          <p className="hint">用假数据在几分钟内验证整条赛程。<b>仅在 DEBUG_MODE=true 时可用,上线前请关闭。</b>会新建一场比赛(成为当前比赛)。</p>
          <div className="row3">
            <div className="field"><label>角色/参赛数</label>
              <input type="number" min={2} value={dbgCount} onChange={(e) => setDbgCount(+e.target.value)} /></div>
            <div className="field"><label>模拟投票人数</label>
              <input type="number" min={1} value={dbgVoters} onChange={(e) => setDbgVoters(+e.target.value)} /></div>
            <div className="field"><label>&nbsp;</label>
              <button className="btn solid" disabled={dbgBusy} onClick={() => dbgAct("simulate", { count: dbgCount, groups: 2, advance: 2, voters: dbgVoters })}>一键模拟整届</button></div>
          </div>
          <hr className="sep" />
          <p className="hint">或分步来(配合上面的赛程按钮):</p>
          <div className="btnrow">
            <button className="btn" disabled={dbgBusy} onClick={() => dbgAct("seed", { count: dbgCount })}>① 造 {dbgCount} 个测试角色</button>
            <button className="btn" disabled={dbgBusy} onClick={() => dbgAct("nominate", { votes: dbgCount * 20 })}>② 灌提名票</button>
            <button className="btn" disabled={dbgBusy} onClick={() => dbgAct("vote", { voters: dbgVoters })}>③ 给当前开放对战灌票</button>
          </div>
          {dbgLog.length > 0 && <pre className="ping-result">{dbgLog.join("\n")}</pre>}
        </div>
      )}

      {/* ── 危险区 ── */}
      <div className="admin-section">⚠️ 危险区</div>
      <div className="card">
        <h3>危险操作</h3>
        <p className="hint">删除当前比赛及其全部数据，无法撤销。</p>
        <button className="btn" disabled={busy} onClick={() => { if (confirm("确认删除当前比赛？")) act("reset"); }}>重置 / 删除当前比赛</button>
      </div>

      </div>

      {msg && <div className={"msg " + (msg.ok ? "ok" : "err")}>{msg.t}</div>}
      <div className="foot"><a href="/">← 返回投票页</a></div>
    </main>
  );
}
