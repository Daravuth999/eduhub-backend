import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, X } from "lucide-react";

/**
 * Compact Telegram support FAB.
 *  - Auto-opens once per session (sessionStorage flag)
 *  - 280px popup, sized to fit on phones without pushing layout
 *  - Tight internal padding (12-14px), 16px corner inset
 *  - Closes on outside click, ESC, scroll, or 8s of inactivity
 */
const POP_SHOWN_KEY = "eduhub_tg_pop_shown";

export default function TelegramFab() {
  const [open, setOpen] = useState(false);
  const popRef = useRef(null);
  const fabRef = useRef(null);
  const autoCloseRef = useRef(null);

  // First-visit auto-open (once per session only)
  useEffect(() => {
    let timer;
    try {
      if (sessionStorage.getItem(POP_SHOWN_KEY)) return;
      timer = window.setTimeout(() => {
        setOpen(true);
        sessionStorage.setItem(POP_SHOWN_KEY, "1");
        autoCloseRef.current = window.setTimeout(() => setOpen(false), 8000);
      }, 4500);
    } catch { /* private mode — silently skip */ }
    return () => {
      if (timer) window.clearTimeout(timer);
      if (autoCloseRef.current) window.clearTimeout(autoCloseRef.current);
    };
  }, []);

  // Outside click + ESC + scroll dismiss
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (fabRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll);
    };
  }, [open]);

  const togglePopup = (e) => {
    e.preventDefault();
    if (autoCloseRef.current) {
      window.clearTimeout(autoCloseRef.current);
      autoCloseRef.current = null;
    }
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        onClick={togglePopup}
        aria-label="Telegram support"
        aria-expanded={open}
        data-testid="telegram-fab"
        className="fixed right-4 bottom-[88px] sm:bottom-5 z-[500] w-12 h-12 rounded-full
                   flex items-center justify-center border border-white/20
                   shadow-[0_8px_28px_rgba(155,92,255,0.55),0_0_14px_rgba(0,224,255,0.4)]
                   transition-transform hover:scale-110 active:scale-95"
        style={{
          background:
            "linear-gradient(135deg,#00e0ff 0%,#9b5cff 50%,#ff3da6 100%)",
        }}
      >
        <Send className="w-[18px] h-[18px] text-white drop-shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={popRef}
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.2, ease: [0.34, 1.2, 0.64, 1] }}
            role="dialog"
            aria-label="Telegram support"
            data-testid="telegram-popup"
            className="fixed right-4 bottom-[150px] sm:bottom-[80px] z-[501]
                       w-[260px] max-w-[calc(100vw-2rem)] rounded-2xl
                       border border-white/[0.10] overflow-hidden backdrop-blur-xl"
            style={{
              background: "rgba(5,0,16,0.94)",
              boxShadow:
                "0 18px 50px rgba(155,92,255,0.35), 0 0 0 1px rgba(0,224,255,0.08)",
            }}
          >
            {/* Header — tight padding */}
            <div
              className="flex items-center gap-2 px-3 py-2.5"
              style={{
                background:
                  "linear-gradient(135deg,#00e0ff 0%,#9b5cff 50%,#ff3da6 100%)",
              }}
            >
              <Send className="w-3.5 h-3.5 text-white shrink-0" />
              <span className="font-semibold text-[12.5px] text-white tracking-wide">
                Telegram Support
              </span>
              <button
                onClick={() => setOpen(false)}
                className="ml-auto w-5 h-5 rounded-full bg-white/20 hover:bg-white/35
                           flex items-center justify-center transition"
                aria-label="Close"
                data-testid="telegram-popup-close"
              >
                <X className="w-3 h-3 text-white" />
              </button>
            </div>

            {/* Body — compact */}
            <div className="px-3.5 py-3">
              <p className="text-[12px] leading-snug text-white/75 mb-3">
                Need help with your studies? Message your instructor for
                course questions or assignments.
              </p>
              <a
                href="https://t.me/alita995"
                target="_blank"
                rel="noopener noreferrer"
                data-testid="telegram-popup-cta"
                className="block w-full text-center px-3 py-2 rounded-lg
                           text-white font-semibold text-[12px]
                           transition hover:-translate-y-px hover:opacity-95"
                style={{
                  background:
                    "linear-gradient(135deg,#00e0ff 0%,#9b5cff 50%,#ff3da6 100%)",
                  boxShadow: "0 4px 14px rgba(155,92,255,0.45)",
                }}
              >
                <Send className="inline w-3 h-3 mr-1.5 -mt-px" />
                Message Instructor
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
