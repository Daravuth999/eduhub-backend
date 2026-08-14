import React from "react";

const STYLE = {
  loading: "text-aurora-gold bg-aurora-gold/10 border-aurora-gold/40",
  success: "text-aurora-lime bg-aurora-lime/10 border-aurora-lime/40",
  error:   "text-aurora-coral bg-aurora-coral/10 border-aurora-coral/40",
  cached:  "text-aurora-cyan bg-aurora-cyan/10 border-aurora-cyan/30",
};

export default function StatusPill({ status, text }) {
  return (
    <div
      className={`inline-flex items-center gap-1.5 text-[0.68rem] font-semibold px-2.5 py-[3px] rounded-full border transition ${STYLE[status] || STYLE.loading}`}
      data-testid={`status-pill-${status}`}
    >
      <span
        className={`w-[5px] h-[5px] rounded-full bg-current ${status === "loading" || status === "success" ? "animate-pulse-dot" : ""}`}
        style={{ boxShadow: "0 0 8px currentColor" }}
      />
      <span>{text}</span>
    </div>
  );
}
