"use client";
import { useEffect, useState } from "react";
import { t, LANGS, type Lang } from "@/lib/i18n";

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

export default function Rules() {
  const [lang, setLang] = useLang();
  const T = (k: string) => t(lang, k);
  return (
    <main className="wrap">
      <div className="langbar">{LANGS.map((L) => <button key={L.code} type="button" className={"lang" + (lang === L.code ? " on" : "")} onClick={() => setLang(L.code)}>{L.label}</button>)}</div>
      <h1 className="title" style={{ fontSize: 30 }}>{T("rules.title")}</h1>
      <p className="subtitle">{T("rules.subtitle")}</p>

      <div className="card">
        <h3>{T("rules.s1.h")}</h3>
        <p className="rules-p">{T("rules.s1.p1")}</p>
        <p className="rules-p">{T("rules.s1.p2")}</p>
        <p className="rules-p">{T("rules.s1.p3")}</p>
      </div>

      <div className="card">
        <h3>{T("rules.s2.h")}</h3>
        <p className="rules-p">{T("rules.s2.p1")}</p>
        <p className="rules-p">{T("rules.s2.p2")}</p>
      </div>

      <div className="card">
        <h3>{T("rules.s3.h")}</h3>
        <p className="rules-p">{T("rules.s3.p1")}</p>
      </div>

      <div className="card">
        <h3>{T("rules.s4.h")}</h3>
        <p className="rules-p">{T("rules.s4.p1")}</p>
        <p className="rules-p">{T("rules.s4.p3")}</p>
        <p className="rules-p">{T("rules.s4.p2")}</p>
      </div>

      <div className="foot"><a href="/">{T("rules.back")}</a></div>
    </main>
  );
}
