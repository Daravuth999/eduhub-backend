// Header.jsx — sticky header; shows Login button when public, student + Logout when authed.
import React from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, Send, LogIn, LogOut, User } from "lucide-react";
import { useAuth } from "../context/AuthContext";

const TITLES = {
  "/":            "Dashboard",
  "/library":     "Classroom Library",
  "/portal":      "My Portal",
  "/portal/me":   "My Portal",
  "/game":        "Lucky Spin",
  "/game/play":   "Lucky Spin",
  "/login":       "Sign In",
  "/systemtest":  "System Test",
  "/assistant":   "AI Assistant",
};

export default function Header({ onMenuClick }) {
  const { pathname } = useLocation();
  const { isAuthenticated, student, logout } = useAuth();
  const title = TITLES[pathname] || (
    Object.entries(TITLES).find(([k]) => k !== "/" && pathname.startsWith(k))?.[1] || "Dashboard"
  );

  return (
    <header
      className="sticky top-0 z-[200] h-[60px] backdrop-blur-xl border-b border-white/[0.08] flex items-center gap-2.5 px-3 sm:px-5"
      style={{ background: "rgba(8,3,22,0.82)" }}
      data-testid="eduhub-header"
    >
      <div
        aria-hidden
        className="absolute bottom-0 left-0 right-0 h-px opacity-60"
        style={{ background: "linear-gradient(90deg, transparent, #00e0ff 25%, #9b5cff 55%, #ff3da6 80%, transparent)" }}
      />
      <button
        onClick={onMenuClick}
        aria-label="Menu"
        data-testid="header-menu-btn"
        className="lg:hidden w-[34px] h-[34px] rounded-[9px] bg-white/[0.05] border border-aurora-violet/30 flex items-center justify-center text-white hover:bg-aurora-violet/15 hover:border-aurora-violet/60 transition"
      >
        <Menu className="w-4 h-4" />
      </button>

      <span className="font-display font-bold text-base tracking-tight text-iridescent" data-testid="header-title">
        {title}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <a
          href="https://t.me/alita995"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Telegram"
          className="hidden sm:inline-flex w-[34px] h-[34px] rounded-[9px] bg-gradient-to-br from-aurora-cyan/15 to-aurora-magenta/15 border border-white/[0.10] items-center justify-center text-white hover:shadow-[0_0_14px_rgba(155,92,255,0.45)] transition"
        >
          <Send className="w-3.5 h-3.5" />
        </a>

        {isAuthenticated ? (
          <div className="flex items-center gap-2">
            <div
              data-testid="header-student-pill"
              className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full text-[0.78rem] font-semibold bg-aurora-violet/10 border border-aurora-violet/30 text-white"
            >
              <User className="w-3.5 h-3.5 text-aurora-cyan" />
              <span className="truncate max-w-[120px]">{student?.name || student?.studentId}</span>
            </div>
            <button
              onClick={logout}
              data-testid="header-logout-btn"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.78rem] font-semibold bg-aurora-magenta/10 border border-aurora-magenta/40 text-aurora-magenta hover:bg-aurora-magenta/20 transition"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        ) : (
          <Link
            to="/login"
            data-testid="header-login-btn"
            className="inline-flex items-center gap-1.5 px-3.5 py-[7px] rounded-full text-[0.78rem] font-semibold bg-aurora-cyan/10 border border-aurora-cyan/40 text-aurora-cyan hover:bg-aurora-cyan/20 hover:shadow-[0_0_14px_rgba(0,224,255,0.5)] transition"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Student Login →</span>
          </Link>
        )}
      </div>
    </header>
  );
}
