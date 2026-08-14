/**
 * Subtle, on-brand backdrop. Two slow-drifting low-opacity colour washes
 * + the global paper-grain noise (already added via body::before).
 *
 * No purple/violet gradients (avoiding AI-slop).
 */
export function AuroraBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden -z-10"
    >
      <div
        className="absolute -top-40 -left-32 h-[28rem] w-[28rem] rounded-full blur-3xl drift opacity-40"
        style={{
          background:
            "radial-gradient(circle, color-mix(in oklab, var(--color-accent) 30%, transparent), transparent 65%)",
        }}
      />
      <div
        className="absolute top-1/3 -right-40 h-[26rem] w-[26rem] rounded-full blur-3xl drift opacity-40"
        style={{
          animationDelay: "-9s",
          background:
            "radial-gradient(circle, color-mix(in oklab, var(--color-accent-warm) 24%, transparent), transparent 65%)",
        }}
      />
      <div
        className="absolute bottom-0 left-1/3 h-[18rem] w-[18rem] rounded-full blur-3xl drift opacity-30"
        style={{
          animationDelay: "-15s",
          background:
            "radial-gradient(circle, color-mix(in oklab, var(--color-good) 20%, transparent), transparent 65%)",
        }}
      />
    </div>
  );
}
