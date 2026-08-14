/**
 * PremiumInteractionShell.jsx — Signature Smart Interactive Book,
 * Checkpoint 1: shared interaction-runtime provider skeleton.
 *
 * Owns exactly the cross-cutting behavior every one of the nine interaction
 * components would otherwise duplicate: ONE IntersectionObserver scoped to
 * the active Reader/book instance (never a module-level immortal singleton —
 * recreated on bookSlug/revision change, fully disconnected on unmount, per
 * §LOCKED CORRECTION 9), a single "which card is expanded" coordinator so
 * opening one card auto-collapses the previous, and a shared
 * prefers-reduced-motion read.
 *
 * Checkpoint 1 ships this provider + hooks only — no visual interaction
 * component exists yet to mount inside it (that is Checkpoint 2+). Tests use
 * a plain <div> child to prove the runtime contract in isolation.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

const InteractionRuntimeContext = createContext(null);

const _DEFAULT_CONTEXT = {
  registerInView: () => () => {},
  expandedId: null,
  setExpandedId: () => {},
  reducedMotion: false,
};

export function InteractionRuntimeProvider({ bookSlug, revision, children }) {
  const callbacksRef = useRef(new Map());
  const [expandedId, setExpandedIdState] = useState(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  // §LOCKED CORRECTION 9: one observer per (bookSlug, revision) identity.
  // Created SYNCHRONOUSLY during render (useMemo, not useEffect) so it
  // already exists by the time ANY effect fires — React runs a child's
  // effects before its parent's, so a child's registerInView() call inside
  // its own mount effect could otherwise race an observer that is only
  // created in the parent's effect and silently fail to register. Cleanup
  // (disconnect + registry clear) still runs via useEffect, keyed on the
  // memoized instance so it fires exactly once per (bookSlug, revision).
  const obs = useMemo(() => {
    if (typeof IntersectionObserver === "undefined") return null;
    return new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const cb = callbacksRef.current.get(entry.target);
        if (cb) cb(entry.isIntersecting);
      });
    }, { rootMargin: "200px 0px" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookSlug, revision]);
  const observerRef = useRef(obs);
  observerRef.current = obs;

  useEffect(() => () => {
    obs?.disconnect();
    callbacksRef.current = new Map();
  }, [obs]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e) => setReducedMotion(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else if (mq.addListener) mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else if (mq.removeListener) mq.removeListener(handler);
    };
  }, []);

  const registerInView = useCallback((element, callback) => {
    if (!element || !observerRef.current) return () => {};
    callbacksRef.current.set(element, callback);
    observerRef.current.observe(element);
    return () => {
      callbacksRef.current.delete(element);
      observerRef.current?.unobserve(element);
    };
  }, []);

  const setExpandedId = useCallback((id) => setExpandedIdState(id), []);

  const value = { registerInView, expandedId, setExpandedId, reducedMotion };
  return (
    <InteractionRuntimeContext.Provider value={value}>{children}</InteractionRuntimeContext.Provider>
  );
}

export function useInteractionRuntime() {
  const ctx = useContext(InteractionRuntimeContext);
  return ctx || _DEFAULT_CONTEXT;
}

/** useInView(ref) — lazy-mount signal for a single interaction card, backed
 * by the ONE shared observer above (never a per-card observer instance). */
export function useInView(ref) {
  const { registerInView } = useInteractionRuntime();
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!ref.current) return undefined;
    return registerInView(ref.current, setInView);
  }, [ref, registerInView]);
  return inView;
}

/** useExpandableCard(id) — "only one card expanded at a time" coordinator. */
export function useExpandableCard(id) {
  const { expandedId, setExpandedId } = useInteractionRuntime();
  const isExpanded = expandedId === id;
  const toggle = useCallback(() => setExpandedId(isExpanded ? null : id), [isExpanded, id, setExpandedId]);
  return [isExpanded, toggle];
}

export default InteractionRuntimeProvider;
