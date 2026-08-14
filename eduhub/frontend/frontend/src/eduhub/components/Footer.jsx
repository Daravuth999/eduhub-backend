import React from "react";
import { Heart } from "lucide-react";

export default function Footer() {
  return (
    <footer
      className="relative px-5 sm:px-6 py-5 text-[0.78rem] text-white/45 flex items-center gap-1.5 flex-wrap"
      style={{ background: "rgba(8,3,22,0.55)" }}
      data-testid="eduhub-footer"
    >
      <div
        className="absolute top-0 left-0 right-0 h-px opacity-60"
        style={{ background: "linear-gradient(90deg, transparent, #00e0ff 25%, #9b5cff 55%, #ff3da6 80%, transparent)" }}
      />
      © 2026 <span className="font-semibold text-iridescent">EduHub Student Portal</span>
      &nbsp;·&nbsp; Designed with{" "}
      <Heart className="w-3.5 h-3.5 inline animate-heartbeat fill-current" style={{ color: "#ff3da6" }} />
      &nbsp;for Learning Excellence
    </footer>
  );
}
