import { useCallback, useEffect, useRef, useState } from "react";
import {
  BACKEND_URL,
  FETCH_TIMEOUT,
  REFRESH_INTERVAL,
  defaultConfig,
  fetchJSONP,
  fetchWithTimeout,
  loadCache,
  normalizeConfig,
  saveCache,
} from "../lib/config";

const STATUS_LABELS = {
  live:    { status: "success", text: "Live" },
  cache:   { status: "cached",  text: "Cached" },
  default: { status: "error",   text: "Offline" },
};

export function useEduHubConfig() {
  const [state, setState] = useState(() => {
    const cached = loadCache();
    if (cached) {
      return { config: normalizeConfig(cached), source: "cache", status: "cached", statusText: "Cached" };
    }
    return { config: defaultConfig, source: "default", status: "loading", statusText: "Loading…" };
  });

  const inflight = useRef(false);

  const update = useCallback(async (isRetry = false) => {
    if (inflight.current) return;
    inflight.current = true;

    setState((s) => ({ ...s, status: "loading", statusText: isRetry ? "Retrying…" : "Fetching…" }));

    const apply = (raw, source) => {
      const cfg = normalizeConfig(raw);
      const meta = STATUS_LABELS[source];
      setState({ config: cfg, source, status: meta.status, statusText: meta.text });
    };

    try {
      const resp = await fetchWithTimeout(BACKEND_URL, FETCH_TIMEOUT);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const json = text.replace(/^[^(]*\(/, "").replace(/\)[^)]*$/, "").trim();
      const data = JSON.parse(json);
      saveCache(normalizeConfig(data));
      apply(data, "live");
      inflight.current = false;
      return;
    } catch { /* fall through */ }

    try {
      const data = await fetchJSONP(BACKEND_URL);
      saveCache(normalizeConfig(data));
      apply(data, "live");
      inflight.current = false;
      return;
    } catch { /* fall through */ }

    const cached = loadCache();
    apply(cached ?? defaultConfig, cached ? "cache" : "default");
    inflight.current = false;
  }, []);

  useEffect(() => {
    update();
    const id = window.setInterval(() => update(), REFRESH_INTERVAL);
    const onVis = () => { if (document.visibilityState === "visible") update(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [update]);

  return { ...state, retry: () => update(true) };
}
