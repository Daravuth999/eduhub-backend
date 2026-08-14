// MobileBottomNav.jsx — 5-tab bottom bar per redesign spec:
//   Home / Library / Spin / Portal / More.
import React from "react";
import { Link, useLocation } from "react-router-dom";
import { Home, Library, Sparkles, GraduationCap, Menu } from "lucide-react";

const ITEMS = [
  { label: "Home",    icon: Home,           to: "/" },
  { label: "Library", icon: Library,        to: "/library" },
  { label: "Spin",    icon: Sparkles,       to: "/game" },
  { label: "Portal",  icon: GraduationCap,  to: "/portal" },
];

export default function MobileBottomNav({ onMore }) {
  const { pathname } = useLocation();
  const isActive = (to) =>
    to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(to + "/");

  return (
    <nav
      aria-label="Primary"
      className="fixed bottom-0 left-0 right-0 z-[400] lg:hidden backdrop-blur-2xl border-t border-white/[0.08] grid grid-cols-5 px-1"
      style={{
        background: "rgba(8,3,22,0.92)",
        paddingTop: "0.375rem",
        paddingBottom: "max(0.375rem, env(safe-area-inset-bottom))",
        width: "100vw",
        maxWidth: "100%",
        boxSizing: "border-box",
      }}
      data-testid="mobile-bottom-nav"
    >
      <div
        aria-hidden
        className="absolute top-0 left-0 right-0 h-px opacity-70"
        style={{
          background:
            "linear-gradient(90deg, transparent, #00e0ff 20%, #9b5cff 50%, #ff3da6 80%, transparent)",
        }}
      />
      {ITEMS.map((it) => {
        const active = isActive(it.to);
        const Icon = it.icon;
        return (
          <Link
            key={it.label}
            to={it.to}
            data-testid={`mobile-tab-${it.label.toLowerCase()}`}
            className={`relative flex flex-col items-center justify-center gap-0.5 py-1.5 rounded-lg text-[0.6rem] font-semibold transition ${
              active ? "text-aurora-cyan" : "text-white/55 hover:text-white"
            }`}
          >
            {active && (
              <span
                aria-hidden
                className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-full"
                style={{
                  background: "linear-gradient(90deg, #00e0ff, #9b5cff, #ff3da6)",
                  boxShadow: "0 0 10px rgba(155,92,255,0.7)",
                }}
              />
            )}
            <Icon
              className={`w-[18px] h-[18px] ${
                active ? "drop-shadow-[0_0_6px_rgba(0,224,255,0.85)]" : ""
              }`}
            />
            <span>{it.label}</span>
          </Link>
        );
      })}
      <button
        onClick={onMore}
        data-testid="mobile-tab-more"
        className="flex flex-col items-center justify-center gap-0.5 py-1.5 rounded-lg text-[0.6rem] font-semibold text-white/55 hover:text-aurora-magenta transition"
      >
        <Menu className="w-[18px] h-[18px]" />
        <span>More</span>
      </button>
    </nav>
  );
}
