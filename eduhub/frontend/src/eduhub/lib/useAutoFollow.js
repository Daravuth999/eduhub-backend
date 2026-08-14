/**
 * useAutoFollow.js — teleprompter-style auto-scroll for a dedicated
 * transcript viewport (never the page). Keeps the active sentence at a
 * configurable anchor with a gentle rAF tween, suspends automatically the
 * moment the user scrolls (wheel / touch / scrollbar — never fights the
 * finger), and resumes via the caller's "Follow playback" affordance.
 * Respects prefers-reduced-motion by jumping instead of tweening.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export default function useAutoFollow({ containerRef, activeIdx, getTargetEl, enabled = true, anchorFor }) {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const tweenRef = useRef(0);
  const lastWrittenTopRef = useRef(null);

  const scrollToActive = useCallback((immediate = false) => {
    const c = containerRef.current;
    const el = typeof getTargetEl === "function" ? getTargetEl() : null;
    if (!c || !el) return;
    const anchor = typeof anchorFor === "function" ? anchorFor(c) : c.clientHeight * 0.35;
    const maxScroll = Math.max(0, c.scrollHeight - c.clientHeight);
    const target = Math.min(maxScroll, Math.max(0, el.offsetTop - anchor + el.clientHeight / 2));
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(tweenRef.current);
    const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (immediate || reduced || typeof requestAnimationFrame !== "function") {
      lastWrittenTopRef.current = target;
      c.scrollTop = target;
      return;
    }
    const from = c.scrollTop;
    const delta = target - from;
    if (Math.abs(delta) < 4) return;
    const duration = Math.max(240, Math.min(650, Math.abs(delta) * 0.9));
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = from + delta * eased;
      lastWrittenTopRef.current = next;
      c.scrollTop = next;
      if (p < 1) tweenRef.current = requestAnimationFrame(step);
    };
    tweenRef.current = requestAnimationFrame(step);
  }, [containerRef, getTargetEl, anchorFor]);

  // Detects when containerRef.current actually changes (attaches/detaches/
  // swaps), independent of React's normal render cycle. A plain
  // `[containerRef, enabled]` dependency array is not enough: `containerRef`
  // is a stable ref OBJECT whose identity never changes, so if the DOM node
  // it points to doesn't exist yet on first render (e.g. Author Studio's
  // Teleprompter preview renders an "empty" state with no container until
  // its sync document finishes loading, then the real container mounts on
  // a later render of the SAME component instance), the listener-attach
  // effect below would never re-run and manual-scroll suspend would stay
  // permanently dead for that session. This tiny watcher runs after every
  // render (cheap reference check, no-op unless the node actually changed)
  // and bumps a counter only when it does, giving the real effect below an
  // accurate re-trigger signal.
  const [containerTick, setContainerTick] = useState(0);
  const lastElRef = useRef(null);
  // Deliberately no dependency array — this must re-check on every render,
  // not just when some dependency changes, since the whole point is to
  // detect a mutation (containerRef.current) that no dependency array can
  // express. The reference-equality guard above makes this safe: it only
  // ever calls setState when the node actually changed, so it cannot loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (containerRef.current !== lastElRef.current) {
      lastElRef.current = containerRef.current;
      setContainerTick((n) => n + 1);
    }
  });

  // Manual-scroll override: any user-driven scroll suspends following.
  useEffect(() => {
    const c = containerRef.current;
    if (!c || !enabled) return undefined;
    const suspend = () => {
      followingRef.current = false;
      setFollowing(false);
    };
    const onScroll = () => {
      // Positions we wrote ourselves are not user intent — only a position
      // that deviates from our last write means a real user scroll.
      const last = lastWrittenTopRef.current;
      if (last === null || Math.abs(c.scrollTop - last) > 2) suspend();
    };
    c.addEventListener("wheel", suspend, { passive: true });
    c.addEventListener("touchmove", suspend, { passive: true });
    c.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      c.removeEventListener("wheel", suspend);
      c.removeEventListener("touchmove", suspend);
      c.removeEventListener("scroll", onScroll);
    };
  }, [containerRef, enabled, containerTick]);

  useEffect(() => {
    if (!enabled || !followingRef.current || activeIdx < 0) return;
    scrollToActive(false);
  }, [activeIdx, enabled, scrollToActive]);

  const resumeFollow = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    scrollToActive(false);
  }, [scrollToActive]);

  useEffect(() => () => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(tweenRef.current);
  }, []);

  return { following, resumeFollow, scrollToActive };
}
