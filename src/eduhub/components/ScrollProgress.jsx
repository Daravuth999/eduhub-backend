import React from "react";
import { useScrollProgress } from "../hooks/useScrollProgress";

export default function ScrollProgress() {
  const p = useScrollProgress();
  return (
    <div
      className="fixed top-0 left-0 h-[3px] z-[9999] transition-[width] duration-100 ease-linear"
      style={{
        width: `${p}%`,
        background: "linear-gradient(90deg, #00e0ff 0%, #9b5cff 35%, #ff3da6 65%, #ffc94d 100%)",
        boxShadow: "0 0 14px rgba(0,224,255,0.7), 0 0 22px rgba(255,61,166,0.5)",
      }}
      aria-hidden
      data-testid="scroll-progress"
    />
  );
}
