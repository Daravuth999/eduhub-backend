// Sidebar.jsx — v6: dropped all third-party iframe links (Live Sessions,
//   Rewards Shop, Dictionary, Attendance, Practical Class, Play & Earn).
//   Sidebar now only lists native in-app destinations.
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link, useLocation } from "react-router-dom";
import {
  GraduationCap, LayoutDashboard, Bot, FlaskConical, Sparkles,
  Library, X, LogIn, LogOut,
} from "lucide-react";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useAuth } from "../context/AuthContext";

const ICONS = {
  LayoutDashboard, Sparkles, GraduationCap, Library, Bot, FlaskConical,
};

// Internal app routes — no iframes, all native React pages.
const INTERNAL_NAV = [
  { label: "Dashboard",         to: "/",           icon: "LayoutDashboard" },
  { label: "Classroom Library", to: "/library",    icon: "Library" },
  { label: "My Portal",         to: "/portal",     icon: "GraduationCap" },
  { label: "Lucky Spin",        to: "/game",       icon: "Sparkles" },
];

// Native AI / test tools (require login).
const PROTECTED_NAV = [
  { label: "AI Assistant", to: "/assistant",  icon: "Bot",          badge: "AI" },
  { label: "System Test",  to: "/systemtest", icon: "FlaskConical", badge: "Live" },
];

function NavLinkItem({ label, to, icon, badge, onClick }) {
  const Icon = ICONS[icon] || LayoutDashboard;
  const { pathname } = useLocation();
  const active = to === "/"
    ? pathname === "/"
    : pathname === to || pathname.startsWith(to + "/");

  const base = "group relative flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] text-[0.83rem] font-medium transition-all";
  const cls = active
    ? "bg-gradient-to-r from-aurora-cyan/15 via-aurora-violet/15 to-aurora-magenta/10 text-white border border-aurora-violet/30 shadow-[0_0_18px_rgba(155,92,255,0.25)]"
    : "text-white/55 hover:text-white hover:bg-white/[0.05] border border-transparent";

  return (
    <Link
      to={to}
      onClick={onClick}
      className={`${base} ${cls}`}
      data-testid={`sidebar-nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-[60%] rounded-r-[3px]"
          style={{
            background: "linear-gradient(180deg, #00e0ff 0%, #9b5cff 50%, #ff3da6 100%)",
            boxShadow: "0 0 12px rgba(155,92,255,0.8)",
          }}
        />
      )}
      <Icon className={`w-[16px] h-[16px] shrink-0 ${active ? "text-aurora-cyan drop-shadow-[0_0_6px_rgba(0,224,255,0.8)]" : "opacity-75"}`} />
      <span className="truncate">{label}</span>
      {badge && (
        <span className="ml-auto bg-gradient-to-r from-aurora-magenta to-aurora-coral text-white text-[0.6rem] font-bold px-1.5 py-[2px] rounded-full">
          {badge}
        </span>
      )}
    </Link>
  );
}

export default function Sidebar({ open, onClose, instructorName = "Daravuth Yon" }) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const { isAuthenticated, student, logout } = useAuth();
  const initials = (student?.name || instructorName)
    .split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  return (
    <>
      <AnimatePresence>
        {open && !isDesktop && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/65 backdrop-blur-[4px] z-[290]"
            aria-hidden
          />
        )}
      </AnimatePresence>

      <motion.aside
        initial={false}
        animate={{ x: isDesktop || open ? 0 : "-100%" }}
        transition={{ type: "spring", stiffness: 320, damping: 32 }}
        className="fixed top-0 left-0 bottom-0 z-[300] w-[256px] backdrop-blur-2xl border-r border-white/[0.08] flex flex-col overflow-y-auto"
        style={{ background: "rgba(8,3,22,0.92)" }}
        data-testid="sidebar"
      >
        <div
          aria-hidden
          className="absolute right-0 top-0 bottom-0 w-px opacity-50"
          style={{ background: "linear-gradient(180deg, transparent, #00e0ff 25%, #9b5cff 55%, #ff3da6 80%, transparent)" }}
        />

        {/* Brand */}
        <div className="px-[18px] py-5 border-b border-white/[0.08] flex items-center gap-3">
          <Link to="/" onClick={onClose} className="flex items-center gap-3">
            <div className="w-[40px] h-[40px] rounded-[12px] flex items-center justify-center bg-gradient-to-br from-aurora-cyan via-aurora-violet to-aurora-magenta shadow-[0_6px_22px_rgba(155,92,255,0.55)]">
              <GraduationCap className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="font-display text-[1.1rem] font-extrabold tracking-tight text-iridescent">EduHub</div>
              <div className="text-[0.68rem] text-white/45 mt-[1px]">Unified Portal</div>
            </div>
          </Link>
          <button
            onClick={onClose}
            className="ml-auto lg:hidden w-7 h-7 rounded-md flex items-center justify-center text-white/60 hover:text-white hover:bg-white/[0.06]"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Main nav */}
        <div className="px-3 pt-4">
          <div className="text-[0.62rem] font-bold tracking-[0.12em] uppercase text-white/25 px-2 mb-1">Main</div>
          <div className="flex flex-col gap-[2px]">
            {INTERNAL_NAV.map((it) => (
              <NavLinkItem key={it.label} {...it} onClick={onClose} />
            ))}
          </div>
        </div>

        {/* Tools (auth-gated) */}
        {isAuthenticated && (
          <div className="px-3 pt-4">
            <div className="text-[0.62rem] font-bold tracking-[0.12em] uppercase text-white/25 px-2 mb-1">
              Smart Tools
            </div>
            <div className="flex flex-col gap-[2px]">
              {PROTECTED_NAV.map((it) => (
                <NavLinkItem key={it.label} {...it} onClick={onClose} />
              ))}
            </div>
          </div>
        )}

        {/* Footer — instructor or student */}
        <div className="mt-auto px-3 py-3.5 border-t border-white/[0.08] space-y-2">
          {isAuthenticated && student ? (
            <>
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-gradient-to-r from-aurora-cyan/[0.10] via-white/[0.04] to-aurora-magenta/[0.10] border border-white/[0.10]">
                <div className="w-9 h-9 rounded-full flex items-center justify-center bg-gradient-to-br from-aurora-cyan via-aurora-violet to-aurora-magenta text-[0.78rem] font-extrabold shadow-[0_4px_14px_rgba(155,92,255,0.5)]">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[0.8rem] font-semibold truncate" data-testid="sidebar-student-name">
                    {student.name || student.studentId}
                  </div>
                  <div className="text-[0.67rem] text-white/45 truncate">
                    {student.portalData?.["Class Group"] || student.portalData?.ClassGroup || "Student"}
                  </div>
                </div>
              </div>
              <button
                onClick={() => { onClose?.(); logout(); }}
                data-testid="sidebar-logout-btn"
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-[0.78rem] font-semibold text-aurora-magenta border border-aurora-magenta/30 bg-aurora-magenta/5 hover:bg-aurora-magenta/15 transition"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-gradient-to-r from-aurora-cyan/[0.08] via-white/[0.04] to-aurora-magenta/[0.08] border border-white/[0.08]">
                <div className="w-9 h-9 rounded-full flex items-center justify-center bg-gradient-to-br from-aurora-cyan via-aurora-violet to-aurora-magenta text-[0.78rem] font-extrabold shadow-[0_4px_14px_rgba(155,92,255,0.5)]">
                  {(instructorName.split(" ").map(p => p[0]).slice(0, 2).join("") || "DY").toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="text-[0.8rem] font-semibold truncate">{instructorName}</div>
                  <div className="text-[0.67rem] text-white/40">Instructor</div>
                </div>
              </div>
              <Link
                to="/login"
                onClick={onClose}
                data-testid="sidebar-login-btn"
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-[0.78rem] font-semibold text-white border border-aurora-violet/35 bg-aurora-violet/15 hover:bg-aurora-violet/25 transition"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Student Login →</span>
              </Link>
            </>
          )}
        </div>
      </motion.aside>
    </>
  );
}
