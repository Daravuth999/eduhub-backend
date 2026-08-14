// PwaDebugPage.jsx — TEMPORARY diagnostic viewer for the installed-PWA
// stale-version investigation. Unprotected route (must be reachable even
// if auth/routing itself is what's misbehaving). Delete this file and its
// route in App.js once the root cause is confirmed and the real fix has
// shipped — see src/eduhub/lib/__pwaDiag.js for the full removal list.
import { useEffect, useState, useCallback } from "react";
import { readDiagLog, clearDiagLog } from "../lib/__pwaDiag";

export default function PwaDebugPage() {
  const [log, setLog] = useState(() => readDiagLog());
  const [live, setLive] = useState(null);

  const refresh = useCallback(() => setLog(readDiagLog()), []);

  useEffect(() => {
    const id = setInterval(refresh, 1000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!("serviceWorker" in navigator)) {
        setLive({ supported: false });
        return;
      }
      const regs = await navigator.serviceWorker.getRegistrations();
      const cacheNames = await caches.keys();
      const cacheDetails = {};
      for (const name of cacheNames) {
        try {
          const c = await caches.open(name);
          cacheDetails[name] = (await c.keys()).length;
        } catch { cacheDetails[name] = "?"; }
      }
      if (cancelled) return;
      setLive({
        supported: true,
        controller: navigator.serviceWorker.controller
          ? { url: navigator.serviceWorker.controller.scriptURL, state: navigator.serviceWorker.controller.state }
          : null,
        registrations: regs.map((r) => ({
          scope: r.scope,
          active: r.active ? { url: r.active.scriptURL, state: r.active.state } : null,
          waiting: r.waiting ? { url: r.waiting.scriptURL, state: r.waiting.state } : null,
          installing: r.installing ? { url: r.installing.scriptURL, state: r.installing.state } : null,
        })),
        caches: cacheDetails,
      });
      // Ask the currently-controlling worker to report its own version.
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage("REPORT_VERSION");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const copyAll = () => {
    const text = JSON.stringify({ live, log }, null, 2);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  };

  return (
    <div style={{ padding: 16, fontFamily: "monospace", fontSize: 12, background: "#0b0b12", color: "#e4e4e7", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 16, marginBottom: 8 }}>PWA Diagnostic (temporary)</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={refresh} style={{ padding: "6px 10px" }}>Refresh</button>
        <button onClick={copyAll} style={{ padding: "6px 10px" }}>Copy all as JSON</button>
        <button onClick={() => { clearDiagLog(); refresh(); }} style={{ padding: "6px 10px" }}>Clear log</button>
      </div>

      <h2 style={{ fontSize: 13, marginTop: 12 }}>Live snapshot (right now)</h2>
      <pre style={{ whiteSpace: "pre-wrap", background: "#16161f", padding: 8, borderRadius: 6, overflowX: "auto" }}>
        {JSON.stringify(live, null, 2)}
      </pre>

      <h2 style={{ fontSize: 13, marginTop: 12 }}>Timeline ({log.length} events, oldest first)</h2>
      <div style={{ background: "#16161f", padding: 8, borderRadius: 6, maxHeight: "60vh", overflowY: "auto" }}>
        {log.length === 0 && <div style={{ opacity: 0.6 }}>No events logged yet.</div>}
        {log.map((e, i) => (
          <div key={i} style={{ marginBottom: 6, borderBottom: "1px solid #2a2a35", paddingBottom: 4 }}>
            <div style={{ color: "#7dd3fc" }}>{new Date(e.ts).toLocaleTimeString()} — {e.event}</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", color: "#a1a1aa" }}>
              {JSON.stringify({ ...e, ts: undefined, iso: undefined, event: undefined }, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
