import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Megaphone, RotateCw, ChevronDown } from "lucide-react";
import StatusPill from "./StatusPill";

function Typewriter({ text, speed, delay, enabled }) {
  const [out, setOut] = useState(enabled ? "" : text);
  useEffect(() => {
    if (!enabled) {
      setOut(text);
      return;
    }
    setOut("");
    let i = 0;
    let timer;
    const start = window.setTimeout(function tick() {
      if (i < text.length) {
        setOut(text.slice(0, ++i));
        timer = window.setTimeout(tick, speed);
      }
    }, delay);
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(timer);
    };
  }, [text, speed, delay, enabled]);

  const done = out.length >= text.length;
  return (
    <>
      {out}
      {enabled && !done && (
        <span
          className="inline-block w-[2px] h-[1em] align-middle bg-aurora-cyan ml-[2px] animate-blink"
          style={{ boxShadow: "0 0 8px rgba(0,224,255,1)" }}
        />
      )}
    </>
  );
}

/**
 * Compact, mobile-first announcement card.
 * - Collapsed by default on mobile when there are 2+ messages (so it never
 *   dominates the viewport).
 * - Smaller paddings, tighter typography vs. the previous layout.
 * - Typewriter still runs for a tasteful effect once expanded / on desktop.
 */
export default function AnnouncementCard({ config, fetchStatus, fetchStatusText, source, onRetry }) {
  const showRetry = source === "default";
  const isLoading = fetchStatus === "loading";
  const messages = config.announcementMessages || [];
  const [expanded, setExpanded] = useState(false);
  const collapsible = messages.length > 1;

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.25, 0.8, 0.25, 1], delay: 0.06 }}
      className="relative overflow-hidden rounded-2xl mb-4 sm:mb-5 backdrop-blur-xl border border-white/[0.08]"
      style={{
        background: "rgba(10,4,30,0.7)",
        boxShadow: "0 12px 36px rgba(0,0,0,0.32), 0 0 0 1px rgba(0,224,255,0.08)",
      }}
      data-testid="announcement-card"
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{
          background: "linear-gradient(180deg, #00e0ff 0%, #9b5cff 35%, #ff3da6 70%, #ffc94d 100%)",
          boxShadow: "0 0 14px rgba(155, 92, 255, 0.5)",
        }}
      />

      <div className="flex items-center flex-wrap gap-2 px-3.5 sm:px-5 pt-2.5 sm:pt-3 pb-2">
        <div className="w-6 h-6 rounded-md flex items-center justify-center bg-gradient-to-br from-aurora-cyan/30 to-aurora-violet/30 text-aurora-cyan">
          <Megaphone className="w-3 h-3" />
        </div>
        <div className="font-display text-[0.7rem] sm:text-[0.74rem] font-bold tracking-[0.07em] uppercase text-iridescent">
          {config.announcementTitle}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <StatusPill status={fetchStatus} text={fetchStatusText} />
          {showRetry && (
            <button
              onClick={onRetry}
              data-testid="announcement-retry-btn"
              className="inline-flex items-center gap-1 bg-aurora-coral/15 border border-aurora-coral/40 text-aurora-coral text-[0.66rem] font-semibold px-2 py-[2px] rounded-full hover:bg-aurora-coral/25 transition"
            >
              <RotateCw className="w-3 h-3" />
              Retry
            </button>
          )}
          {collapsible && (
            <button
              onClick={() => setExpanded((v) => !v)}
              data-testid="announcement-toggle-btn"
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse announcements" : "Expand announcements"}
              className="inline-flex items-center justify-center w-6 h-6 rounded-full text-white/55 hover:text-white hover:bg-white/[0.08] transition sm:hidden"
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
            </button>
          )}
        </div>
      </div>

      <div className="px-3.5 sm:px-5 pb-3">
        <AnimatePresence mode="wait">
          {isLoading && source !== "live" && source !== "cache" ? (
            <motion.div key="skel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="h-[11px] rounded-md mb-1.5 w-[88%] skeleton" />
              <div className="h-[11px] rounded-md w-[66%] skeleton" />
            </motion.div>
          ) : (
            <motion.div
              key="msgs"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.25 }}
              className="space-y-1.5"
            >
              {messages.map((msg, idx) => {
                const isKhmer = /[\u1780-\u17FF]/.test(msg);
                const delay = (config.initialDelay + idx * config.betweenMessagesDelay) * 1000;
                // On mobile, hide messages beyond the first one until expanded.
                const hiddenOnMobile = collapsible && idx > 0 && !expanded;
                return (
                  <motion.p
                    key={idx + msg.slice(0, 12)}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, delay: config.initialDelay + idx * 0.08 }}
                    className={`${
                      hiddenOnMobile ? "hidden sm:block" : ""
                    } text-[0.78rem] sm:text-[0.83rem] leading-[1.6] text-white/[0.86] px-2.5 py-1.5 rounded-[8px] bg-white/[0.04] border border-white/[0.06] ${
                      isKhmer ? "font-khmer text-[0.88rem] sm:text-[0.92rem] text-aurora-cyan" : ""
                    }`}
                  >
                    <Typewriter text={msg.trim()} speed={config.typewriterSpeed} delay={delay} enabled={config.enableTypewriter} />
                  </motion.p>
                );
              })}
              {collapsible && !expanded && (
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  data-testid="announcement-show-more-btn"
                  className="sm:hidden text-[0.7rem] font-semibold text-aurora-cyan/85 hover:text-aurora-cyan inline-flex items-center gap-1 mt-0.5"
                >
                  Show {messages.length - 1} more
                  <ChevronDown className="w-3 h-3" />
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}
