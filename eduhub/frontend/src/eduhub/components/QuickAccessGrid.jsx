// QuickAccessGrid.jsx — v6: only native in-app destinations remain. All
//   third-party github.io and external HTML utility tiles are removed.
import React from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  Bot, FlaskConical, GraduationCap, Sparkles, Library, ArrowUpRight,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useUnifiedBadges } from "../hooks/useUnifiedBadges";

const TILES = [
  {
    title: "AI Assistant",
    desc: "Streamed answers · cached for speed",
    khmer: "ជំនួយការ AI",
    to: "/assistant",
    Icon: Bot,
    gradient: "linear-gradient(135deg,#9b5cff,#ff3da6,#00e0ff)",
    border: "border-aurora-violet/40 hover:shadow-[0_18px_55px_rgba(155,92,255,0.40)]",
    badge: "Fast",
  },
  {
    title: "System Test",
    desc: "Secure IELTS-style speaking test",
    khmer: "តេស្តប្រព័ន្ធ",
    to: "/systemtest",
    Icon: FlaskConical,
    gradient: "linear-gradient(135deg,#ff7a3a,#ffc94d,#ff3da6)",
    border: "border-aurora-coral/45 hover:shadow-[0_18px_55px_rgba(255,122,58,0.45)]",
    badge: "Live",
  },
  {
    title: "Classroom Library",
    desc: "Stories · conversations · exercises",
    khmer: "បណ្ណាល័យ",
    to: "/library",
    Icon: Library,
    gradient: "linear-gradient(135deg,#ffc94d,#D4A843,#9C7A2C)",
    border: "border-aurora-gold/40 hover:shadow-[0_18px_55px_rgba(255,201,77,0.35)]",
    badge: "📚",
    badgeModule: "library",
  },
  {
    title: "My Portal",
    desc: "Evaluation · points · feedback",
    khmer: "ផ្ទាំងផ្ទាល់ខ្លួន",
    to: "/portal",
    Icon: GraduationCap,
    gradient: "linear-gradient(135deg,#00e0ff,#9b5cff)",
    border: "border-aurora-cyan/35 hover:shadow-[0_18px_50px_rgba(0,224,255,0.35)]",
    badge: "EN/KH",
    badgeModule: "wallet",
  },
  {
    title: "Lucky Spin",
    desc: "Spin · win real classroom rewards",
    khmer: "សៀរ៉ុមសំណាង",
    to: "/game",
    Icon: Sparkles,
    gradient: "linear-gradient(135deg,#ff3da6,#ffc94d,#9b5cff)",
    border: "border-aurora-magenta/45 hover:shadow-[0_18px_55px_rgba(255,61,166,0.40)]",
    badge: "🎰",
  },
];

function SectionHeader({ label }) {
  return (
    <div className="flex items-center gap-2.5 mb-4 mt-1.5">
      <div className="font-display text-[0.72rem] font-bold tracking-[0.14em] uppercase whitespace-nowrap text-iridescent">
        {label}
      </div>
      <div
        className="flex-1 h-px"
        style={{ background: "linear-gradient(90deg, rgba(155,92,255,0.5), rgba(255,61,166,0.3), transparent)" }}
      />
    </div>
  );
}

export default function QuickAccessGrid() {
  const { isAuthenticated } = useAuth();
  const { byModule } = useUnifiedBadges();
  return (
    <div data-testid="quick-access-grid">
      <SectionHeader label="Quick Access · all in-app" />
      <div className="grid gap-2.5 sm:gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 mb-6">
        {TILES.map((card, i) => {
          const Icon = card.Icon;
          // Part 1 — My Portal is now auth-aware too.  We keep the
          // public landing /portal accessible via direct URL, but the
          // tile in QuickAccessGrid jumps straight to the private
          // dashboard for logged-in students and through /login for
          // everyone else.  Other auth-gated tiles keep their existing
          // /login?redirect=<path> flow.
          const needsAuth = ["/assistant", "/systemtest", "/library"].includes(card.to);
          let to = card.to;
          if (card.to === "/portal") {
            to = isAuthenticated ? "/portal/me" : "/login?redirect=/portal/me";
          } else if (needsAuth && !isAuthenticated) {
            to = `/login?redirect=${encodeURIComponent(card.to)}`;
          }
          return (
            <motion.div
              key={card.title}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.05 + i * 0.04, ease: [0.34, 1.56, 0.64, 1] }}
              whileHover={{ y: -6, scale: 1.015 }}
              whileTap={{ y: -2, scale: 0.99 }}
            >
              <Link
                to={to}
                data-testid={`quick-link-${card.title.toLowerCase().replace(/\s+/g, "-")}`}
                className={`group relative overflow-hidden flex flex-col p-4 sm:p-[18px] rounded-2xl border bg-white/[0.04] backdrop-blur-md min-h-[124px] transition-all duration-300 ${card.border}`}
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute -top-6 -right-6 w-20 h-20 rounded-full opacity-0 group-hover:opacity-50 transition-opacity duration-500 blur-2xl"
                  style={{ background: card.gradient }}
                />
                <div className="relative z-10 flex items-center justify-between mb-3">
                  <div
                    className="relative w-[40px] h-[40px] rounded-[12px] flex items-center justify-center text-white shadow-[0_6px_22px_rgba(0,0,0,0.45)] transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6"
                    style={{ background: card.gradient }}
                  >
                    <Icon className="w-[18px] h-[18px]" />
                    {card.badgeModule && isAuthenticated && byModule[card.badgeModule] > 0 && (
                      <span
                        aria-hidden
                        data-testid={`quick-badge-${card.title.toLowerCase().replace(/\s+/g, "-")}`}
                        className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 grid place-items-center bg-[#ff5470] text-white text-[0.55rem] font-bold rounded-full border-2 border-[#0a0a12] shadow-[0_0_8px_rgba(255,84,112,0.6)]"
                      >
                        {byModule[card.badgeModule] > 9 ? "9+" : byModule[card.badgeModule]}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-white/15 bg-white/[0.05] text-white/65">
                    {card.badge}
                  </span>
                </div>
                <div className="relative z-10 font-display text-[0.92rem] font-bold mb-[3px] text-white">
                  {card.title}
                </div>
                <div className="relative z-10 text-[0.72rem] text-white/55 leading-snug">
                  {card.desc}
                </div>
                {card.khmer && (
                  <div className="relative z-10 font-khmer text-[0.82rem] mt-1 bg-gradient-to-r from-aurora-cyan to-aurora-magenta bg-clip-text text-transparent">
                    {card.khmer}
                  </div>
                )}
                <ArrowUpRight className="absolute bottom-3 right-3 w-3.5 h-3.5 text-white/30 group-hover:text-white transition-colors" />
              </Link>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
