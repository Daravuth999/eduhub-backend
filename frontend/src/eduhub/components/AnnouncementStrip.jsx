// AnnouncementStrip.jsx — compact ~40px LIVE strip with rotating marquee
//   announcement messages. Replaces the bulky AnnouncementCard on Dashboard
//   while keeping the same data source (useEduHubConfig) intact.
import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Megaphone, RotateCw, ChevronDown, ChevronUp } from "lucide-react";
import StatusPill from "./StatusPill";

export default function AnnouncementStrip({
  config,
  fetchStatus,
  fetchStatusText,
  source,
  onRetry,
}) {
  const messages = (config?.announcementMessages || []).filter(Boolean);
  const showRetry = source === "default";
  const [idx, setIdx] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (messages.length < 2) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % messages.length), 6500);
    return () => clearInterval(id);
  }, [messages.length]);

  const current = messages[idx] || "";
  const isKhmer = /[\u1780-\u17FF]/.test(current);

  return (
    <motion.section
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
      className="relative mb-3 sm:mb-4 rounded-2xl overflow-hidden border border-white/[0.08]"
      style={{
        background:
          "linear-gradient(90deg, rgba(0,224,255,0.08) 0%, rgba(155,92,255,0.08) 50%, rgba(255,61,166,0.08) 100%)",
        backdropFilter: "blur(14px)",
      }}
      data-testid="announcement-strip"
    >
      {/* Top accent line */}
      <div
        aria-hidden
        className="absolute left-0 right-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, #00e0ff 25%, #9b5cff 55%, #ff3da6 80%, transparent)",
        }}
      />

      {/* Compact strip */}
      <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 min-h-[40px]">
        {/* Live dot + icon */}
        <div className="flex items-center gap-1.5 flex-none">
          <span
            className="relative w-2 h-2 rounded-full bg-aurora-coral"
            style={{ boxShadow: "0 0 10px #ff7a3a, 0 0 16px rgba(255,122,58,0.6)" }}
          >
            <span className="absolute inset-0 rounded-full bg-aurora-coral animate-ping opacity-60" />
          </span>
          <span className="text-[9px] font-extrabold tracking-[0.2em] uppercase text-aurora-coral hidden sm:inline">
            Live
          </span>
          <Megaphone className="w-3.5 h-3.5 text-aurora-cyan sm:hidden" />
        </div>

        {/* Marquee message */}
        <div className="relative flex-1 min-w-0 overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.div
              key={idx + ":" + current.slice(0, 12)}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              className={`whitespace-nowrap text-[0.78rem] sm:text-[0.84rem] truncate ${
                isKhmer ? "font-khmer text-aurora-cyan" : "text-white/90"
              }`}
              data-testid="announcement-strip-msg"
            >
              {current || (
                <span className="text-white/40">Loading announcements…</span>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Right cluster: indicators + retry + expand */}
        <div className="flex items-center gap-1.5 flex-none">
          {messages.length > 1 && (
            <div className="hidden sm:flex items-center gap-1 mr-1">
              {messages.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`Show announcement ${i + 1}`}
                  onClick={() => setIdx(i)}
                  className={`h-1.5 rounded-full transition-all ${
                    i === idx
                      ? "w-4 bg-gradient-to-r from-aurora-cyan to-aurora-magenta"
                      : "w-1.5 bg-white/25 hover:bg-white/45"
                  }`}
                />
              ))}
            </div>
          )}

          <StatusPill status={fetchStatus} text={fetchStatusText} />

          {showRetry && (
            <button
              onClick={onRetry}
              data-testid="announcement-strip-retry"
              className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-aurora-coral/40 bg-aurora-coral/15 text-aurora-coral hover:bg-aurora-coral/25 transition"
              aria-label="Retry"
            >
              <RotateCw className="w-3 h-3" />
            </button>
          )}

          {messages.length > 1 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              data-testid="announcement-strip-toggle"
              aria-expanded={open}
              aria-label={open ? "Collapse" : "Expand"}
              className="inline-flex items-center justify-center w-6 h-6 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition"
            >
              {open ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Expanded list */}
      <AnimatePresence initial={false}>
        {open && messages.length > 1 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="border-t border-white/[0.08] overflow-hidden"
          >
            <ul className="px-3 sm:px-4 py-2 space-y-1.5">
              {messages.map((m, i) => {
                const km = /[\u1780-\u17FF]/.test(m);
                return (
                  <li
                    key={i}
                    className={`flex items-start gap-2 text-[0.78rem] leading-relaxed ${
                      km ? "font-khmer text-aurora-cyan" : "text-white/85"
                    }`}
                  >
                    <span className="mt-1.5 h-1 w-1 flex-none rounded-full bg-gradient-to-r from-aurora-cyan to-aurora-magenta" />
                    <span>{m}</span>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
