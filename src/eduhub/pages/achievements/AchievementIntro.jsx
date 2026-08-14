// AchievementIntro.jsx — one-time first-open explainer inside the
// Achievement Center sheet.
//
// Shown inline (no popup-on-popup) the first time a student ever opens the
// Achievement Center, dismissed forever with one tap (localStorage flag —
// the same lightweight persistence convention PushOptInPrompt uses).
// Three short rows answer the three first-timer questions: what trophies
// are, that every trophy holds a reward, and how the next one unlocks.
// English leads; Khmer assists.
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trophy, Gift, LockOpen } from "lucide-react";

const LS_KEY = "eduhub_achievement_intro_seen_v1";

const ROWS = [
  {
    Icon: Trophy,
    en: "Trophies celebrate your learning",
    km: "រៀន និងធ្វើសកម្មភាព ដើម្បីទទួលពានរង្វាន់",
  },
  {
    Icon: Gift,
    en: "Every trophy holds a points reward",
    km: "ពាននីមួយៗអមដោយពិន្ទុរង្វាន់",
  },
  {
    Icon: LockOpen,
    en: "Reach the goals to unlock the next tier",
    km: "សម្រេចគោលដៅ ដើម្បីដោះសោពានបន្ទាប់",
  },
];

export default function AchievementIntro() {
  const [visible, setVisible] = useState(() => {
    try { return !localStorage.getItem(LS_KEY); } catch { return false; }
  });

  const dismiss = () => {
    try { localStorage.setItem(LS_KEY, "1"); } catch { /* ignore */ }
    setVisible(false);
  };

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
          data-testid="achievement-intro"
        >
          <div
            className="mt-3 rounded-2xl border border-violet-200/70 dark:border-violet-500/25 p-4"
            style={{ background: "linear-gradient(180deg, rgba(139,92,246,0.07) 0%, rgba(139,92,246,0.02) 100%)" }}
          >
            <p className="text-[10px] uppercase tracking-wide font-bold text-violet-500/90">Welcome to your achievements</p>
            <div className="mt-2.5 space-y-2.5">
              {ROWS.map(({ Icon, en, km }) => (
                <div key={en} className="flex items-start gap-2.5">
                  <span className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-violet-500/10 text-violet-500 dark:text-violet-300">
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[0.8rem] font-bold text-ink dark:text-white leading-snug">{en}</p>
                    <p className="font-khmer text-[0.72rem] text-zinc-500 dark:text-white/45 leading-snug">{km}</p>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={dismiss}
              className="mt-3.5 w-full py-2 rounded-full text-[0.78rem] font-bold text-violet-600 dark:text-violet-300 bg-violet-500/10 active:scale-[0.97] transition-transform"
              data-testid="achievement-intro-dismiss"
            >
              Got it · យល់ហើយ
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
