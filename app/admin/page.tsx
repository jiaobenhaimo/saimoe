"use client";

import { useCallback, useEffect, useState } from "react";

export default function Admin() {
  const [token, setToken] = useState("");
  const [state, setState] = useState<any>(null);
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);

  const [title, setTitle] = useState("Bangumi 世萌大会 2026");
  const [size, setSize] = useState(16);
  const [groups, setGroups] = useState(4);
  const [advance, setAdvance] = useState(2);

  // edit-info form (title + description of an existing competition)
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");

  useEffect(() => { setToken(localStorage.getItem("adminToken") || ""); }, []);

  const load = useCallback(async () => {
    const r = await fetch("/api/state", { cache: "no-store" });
    setState(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    localStorage.setItem("adminToken", token);
    setMsg(null);
    const r = await fetch("/api/admin/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": token },
      body: JSON.stringify({ action, ...extra }),
    });
    const j = await r.json();
    if (!r.ok) setMsg({ t: j.error || "操作失败", ok: false });
    else setMsg({ t: "已执行:" + action, ok: true });
    await load();
  };

  const comp = state?.competition;
  const phase = comp?.phase;

  // Prefill the edit form whenever a (different) competition loads, without
  // clobbering the admin's typing on re-fetches of the same competition.
  useEffect(() => {
    if (comp) {
      setEditTitle(comp.title || "");
      setEditDesc(comp.description || "");
    }
  }, [comp?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const qualifiers = groups * advance;
  const pow2 = qualifiers >= 2 && (qualifiers & (qualifiers - 1)) === 0;

  return (
    <main className="wrap admin">
      <div className="eyebrow">Admin</div>
      <h1 className="title" style={{ fontSize: 30 }}>赛事控制台</h1>
      <p className="subtitle">推进比赛阶段。所有操作需要管理员令牌(环境变量 <code>ADMIN_TOKEN</code>)。</p>

      <div className="card">
        <div className="field"><label>管理员令牌</label>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_TOKEN" /></div>
      </div>

      <div className="card">
        <h3>当前状态</h3>
        {comp ? (
          <p style={{ margin: 0 }}>
            《{comp.title}》— 阶段:<b>{phase}</b>
            {comp.groupsCount ? ` · ${comp.groupsCount} 组,每组取 ${comp.advancePerGroup}` : ""}
          </p>
        ) : <p style={{ margin: 0, color: "var(--muted)" }}>暂无比赛。</p>}
      </div>

      {comp && (
        <div className="card">
          <h3>编辑比赛信息</h3>
          <div className="field"><label>比赛名称</label>
            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} /></div>
          <div className="field"><label>简介 / 副标题(可选,显示在投票页标题下方)</label>
            <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
              placeholder="例如:2026 春季 · 由你决定最萌角色" /></div>
          <button className="btn solid" disabled={!editTitle.trim()}
            onClick={() => act("update", { title: editTitle, description: editDesc })}>
            保存修改
          </button>
        </div>
      )}

      {(!comp || phase === "finished") && (
        <div className="card">
          <h3>① 创建新一届</h3>
          <div className="field"><label>标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <button className="btn solid" onClick={() => act("create", { title })}>创建比赛(进入提名阶段)</button>
        </div>
      )}

      {phase === "nomination" && (
        <div className="card">
          <h3>② 结束提名,开小组赛</h3>
          <div className="row3">
            <div className="field"><label>参赛人数</label>
              <input type="number" value={size} onChange={(e) => setSize(+e.target.value)} /></div>
            <div className="field"><label>小组数</label>
              <input type="number" value={groups} onChange={(e) => setGroups(+e.target.value)} /></div>
            <div className="field"><label>每组晋级</label>
              <input type="number" value={advance} onChange={(e) => setAdvance(+e.target.value)} /></div>
          </div>
          <p className="hint" style={{ color: pow2 ? "var(--muted)" : "var(--rose-deep)" }}>
            晋级总数 = {qualifiers}{pow2 ? "(是 2 的幂 ✓)" : "(需为 2 的幂:4 / 8 / 16…)"}
          </p>
          <button className="btn solid" disabled={!pow2}
            onClick={() => act("start_groups", { size, groups, advance })}>
            取提名前 {size} 名,分 {groups} 组循环
          </button>
        </div>
      )}

      {phase === "group" && (
        <div className="card">
          <h3>③ 结束小组赛,开淘汰赛</h3>
          <p className="hint">按当前票数结算每组名次,晋级者进入单败淘汰赛。</p>
          <button className="btn solid" onClick={() => act("start_knockout")}>结算小组赛 → 生成淘汰赛</button>
        </div>
      )}

      {phase === "knockout" && (
        <div className="card">
          <h3>④ 推进淘汰赛一轮</h3>
          <p className="hint">按当前票数结算本轮,生成下一轮;打到只剩 1 人时产生冠军。</p>
          <button className="btn solid" onClick={() => act("advance")}>结算本轮 → 下一轮 / 决出冠军</button>
        </div>
      )}

      <div className="card">
        <h3>危险操作</h3>
        <p className="hint">删除当前比赛及其全部数据,无法撤销。</p>
        <button className="btn" onClick={() => { if (confirm("确认删除当前比赛?")) act("reset"); }}>重置 / 删除当前比赛</button>
      </div>

      {msg && <div className={"msg " + (msg.ok ? "ok" : "err")}>{msg.t}</div>}
      <div className="foot"><a href="/">← 返回投票页</a></div>
    </main>
  );
}
