import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  value: number;
  decimals?: number;
  duration?: number;
  /** Multiply the displayed value (e.g. 100 to count up percentages). */
  prefix?: string;
  suffix?: string;
  className?: string;
  /** Localise digits to Khmer when language is "km". */
  localise?: boolean;
}

/**
 * Animates an integer or float value counting up to its target.
 * Honours `prefers-reduced-motion`.
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  duration = 1200,
  prefix = "",
  suffix = "",
  className,
  localise = false,
}: Props) {
  const { num: localiseNum } = useLang();
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState<number>(reduced ? value : 0);
  const startRef = useRef<number | null>(null);
  const fromRef = useRef<number>(reduced ? value : 0);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      return;
    }
    fromRef.current = display;
    startRef.current = null;
    let raf = 0;

    function tick(now: number) {
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;
      const t = Math.min(1, elapsed / duration);
      // EaseOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      const next = fromRef.current + (value - fromRef.current) * eased;
      setDisplay(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduced, duration]);

  const formatted = display.toFixed(decimals);
  // Add thousands separator for ints (e.g. points balance)
  const withSep =
    decimals === 0
      ? Number(formatted).toLocaleString("en-US")
      : formatted;
  const out = localise ? localiseNum(withSep) : withSep;

  return (
    <span className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {prefix}
      {out}
      {suffix}
    </span>
  );
}
