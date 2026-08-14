import { useEffect, useRef, useState } from 'react'

function useCountUp(target, duration = 1200) {
  const [val, setVal] = useState(0)
  const raf = useRef(null)
  const startTs = useRef(null)
  const startVal = useRef(0)

  useEffect(() => {
    cancelAnimationFrame(raf.current)
    startVal.current = val
    startTs.current = null
    const step = (ts) => {
      if (!startTs.current) startTs.current = ts
      const t = Math.min((ts - startTs.current) / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3) // easeOutCubic
      setVal(Math.round(startVal.current + (target - startVal.current) * eased))
      if (t < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  return val
}

export default function StatCard({
  icon,
  label,
  khmer,
  value,
  tint = '#D4A843',
  suffix = '',
  testid,
}) {
  const display = useCountUp(Number(value) || 0)

  return (
    <div
      data-testid={testid}
      className="relative overflow-hidden rounded-2xl border border-parchment/10 bg-mahogany/70 p-3 transition-transform duration-300 hover:-translate-y-0.5"
      style={{
        boxShadow:
          'inset 0 1px 0 rgba(240,230,200,0.06), 0 12px 24px -16px rgba(0,0,0,0.7)',
      }}
    >
      {/* Subtle tinted glow */}
      <div
        className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-40 blur-2xl"
        style={{ background: tint }}
      />
      <div className="flex items-center justify-between">
        <span
          className="grid h-7 w-7 place-items-center rounded-lg"
          style={{
            background: `${tint}1A`,
            color: tint,
            border: `1px solid ${tint}40`,
          }}
        >
          {icon}
        </span>
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-faded">
          {label}
        </span>
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="font-display tabular text-[28px] leading-none text-parchment">
          {display.toLocaleString()}
        </span>
        {suffix && (
          <span className="text-xs font-medium text-faded">{suffix}</span>
        )}
      </div>
      <div className="khmer mt-1 text-[11px] text-faded">{khmer}</div>
    </div>
  )
}
