/**
 * StudioHome.jsx — Studio OS command center.
 *
 * Replaces the previous hardcoded `useState("editor")` default. Every card
 * here is read-only and reads from an endpoint/helper some OTHER tab
 * already calls (see studioHomeApi.js's own header for exactly which, and
 * what was deliberately left out rather than faked). Tapping a card or a
 * recent/frequent/favorite pill calls the SAME `onNavigate` ->
 * `handleTabChange` every existing tab button already calls — Home adds a
 * new front door, not a new navigation mechanism.
 *
 * Each signal fetch is independent and fails silently (studioHomeApi.js
 * returns null on error) — one slow/broken endpoint never blocks the rest
 * of the dashboard from rendering, matching this codebase's established
 * "fail silently for non-critical" convention.
 */
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  PenSquare, Users, Wallet, KeyRound, BrainCircuit, Mic, BookOpen,
  Star, Clock, TrendingUp, ChevronRight,
} from "lucide-react";
import {
  getNeedsEncouragement, getPendingPayments, getPendingPasswordResets,
  getAiUsageToday, getLiveCoachHealth, getBookPublishingStatus,
} from "./studioHomeApi";
import { spring, stagger } from "../eduhub/styles/tokens/motionTokens";

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4A843]";

const TONE = {
  amber:   { text: "text-amber-300",   bg: "bg-amber-500/10",   border: "border-amber-400/25" },
  gold:    { text: "text-gold",        bg: "bg-gold/10",        border: "border-gold/25" },
  rose:    { text: "text-rose-300",    bg: "bg-rose-500/10",    border: "border-rose-400/25" },
  violet:  { text: "text-violet-300",  bg: "bg-violet-500/10",  border: "border-violet-400/25" },
  emerald: { text: "text-emerald-300", bg: "bg-emerald-500/10", border: "border-emerald-400/25" },
  info:    { text: "text-sky-300",     bg: "bg-sky-500/10",     border: "border-sky-400/25" },
};

const cardEntranceVariants = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0 },
};

function SignalCard({ icon: Icon, tone, title, sub, onClick, testid, prefersReducedMotion }) {
  const t = TONE[tone] || TONE.gold;
  return (
    <motion.button
      type="button"
      onClick={onClick}
      data-testid={testid}
      variants={prefersReducedMotion ? undefined : cardEntranceVariants}
      whileTap={prefersReducedMotion ? undefined : { scale: 0.98 }}
      transition={spring.settle}
      className={`w-full text-left flex items-center gap-3 rounded-2xl border ${t.border} ${t.bg} px-4 py-3.5 transition-all duration-150 hover:brightness-110 hover:-translate-y-0.5 ${FOCUS_RING}`}
    >
      <span className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg ${t.bg} ${t.text}`}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13.5px] font-bold text-parchment truncate">{title}</span>
        <span className="block text-[11px] text-faded truncate">{sub}</span>
      </span>
      <ChevronRight className="h-4 w-4 text-faded flex-shrink-0" />
    </motion.button>
  );
}

function PillRow({ icon: Icon, label, items, tabByKey, onNavigate, emptyHint, testidPrefix }) {
  if (!items || items.length === 0) {
    return (
      <div>
        <div className="flex items-center gap-1.5 mb-2 text-[10.5px] font-bold uppercase tracking-wider text-faded">
          <Icon className="h-3 w-3" /> {label}
        </div>
        <p className="text-[11.5px] text-faded/70">{emptyHint}</p>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2 text-[10.5px] font-bold uppercase tracking-wider text-faded">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((key) => {
          const tab = tabByKey[key];
          if (!tab) return null;
          const TabIcon = tab.Icon;
          return (
            <motion.button
              key={key}
              type="button"
              onClick={() => onNavigate(key)}
              whileTap={{ scale: 0.94 }}
              transition={spring.tap}
              data-testid={`${testidPrefix}-${key}`}
              className={`inline-flex items-center gap-1.5 rounded-full border border-parchment/15 bg-walnut/60 px-3 py-1.5 text-[11px] font-semibold text-parchment/90 transition-colors duration-150 hover:border-gold hover:text-gold ${FOCUS_RING}`}
            >
              <TabIcon className="h-3 w-3" /> {tab.label}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

export default function StudioHome({ tabs, onNavigate, memory, draftSummary }) {
  const [signals, setSignals] = useState(null);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    let alive = true;
    Promise.all([
      getNeedsEncouragement(), getPendingPayments(), getPendingPasswordResets(),
      getAiUsageToday(), getLiveCoachHealth(), getBookPublishingStatus(),
    ]).then(([encouragement, payments, resets, aiUsage, liveCoach, books]) => {
      if (alive) setSignals({ encouragement, payments, resets, aiUsage, liveCoach, books });
    });
    return () => { alive = false; };
  }, []);

  const tabByKey = Object.fromEntries(tabs.map((t) => [t.key, t]));
  const s = signals || {};
  const plural = (n) => (n === 1 ? "" : "s");

  const cards = [
    s.encouragement?.count > 0 && {
      key: "attendance", icon: Users, tone: "amber",
      title: `${s.encouragement.count} student${plural(s.encouragement.count)} need encouragement`,
      sub: "Attendance · below threshold",
      testid: "studio-home-card-attendance",
      onClick: () => onNavigate("attendance"),
    },
    s.payments?.count > 0 && {
      key: "payments", icon: Wallet, tone: "gold",
      title: `${s.payments.count} payment${plural(s.payments.count)} awaiting approval`,
      sub: "Payments dashboard",
      testid: "studio-home-card-payments",
      onClick: () => onNavigate("payments"),
    },
    s.resets?.count > 0 && {
      key: "teacher", icon: KeyRound, tone: "rose",
      title: `${s.resets.count} password reset${plural(s.resets.count)} pending`,
      sub: "Students",
      testid: "studio-home-card-resets",
      onClick: () => onNavigate("teacher"),
    },
    s.aiUsage && {
      key: "aitools", icon: BrainCircuit, tone: "violet",
      title: `${s.aiUsage.count} AI session${plural(s.aiUsage.count)} today`,
      sub: "AI Tools · Usage Logs",
      testid: "studio-home-card-ai-usage",
      onClick: () => onNavigate("aitools"),
    },
    s.liveCoach && {
      key: "aitools", icon: Mic, tone: s.liveCoach.ready ? "emerald" : "amber",
      title: s.liveCoach.ready ? "Live Voice Coach — healthy" : "Live Voice Coach — needs attention",
      sub: "Backend readiness",
      testid: "studio-home-card-live-coach",
      onClick: () => onNavigate("aitools"),
    },
    s.books && {
      key: "browse", icon: BookOpen, tone: "info",
      title: `${s.books.live} live · ${s.books.draft} draft`,
      sub: "Book publishing status",
      testid: "studio-home-card-books",
      onClick: () => onNavigate("browse"),
    },
  ].filter(Boolean);

  return (
    <div className="space-y-6" data-testid="studio-home">
      {draftSummary && (
        <motion.button
          type="button"
          onClick={() => onNavigate("editor")}
          whileTap={prefersReducedMotion ? undefined : { scale: 0.99 }}
          transition={spring.tap}
          data-testid="studio-home-continue-draft"
          className={`w-full text-left flex items-center gap-3 rounded-2xl border border-gold/30 px-5 py-4 transition-all duration-150 hover:border-gold/50 hover:brightness-110 ${FOCUS_RING}`}
          style={{ background: "linear-gradient(135deg, rgba(212,168,67,0.14), rgba(45,31,62,0.4))" }}
        >
          <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl bg-gold/15 text-gold">
            <PenSquare className="h-5 w-5" />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-gold">Continue working</span>
            <span className="block text-[15px] font-bold text-parchment truncate">{draftSummary.title || "Untitled draft"}</span>
            {draftSummary.chapterCount != null && (
              <span className="block text-[11.5px] text-faded">{draftSummary.chapterCount} chapter{plural(draftSummary.chapterCount)}</span>
            )}
          </span>
          <ChevronRight className="h-5 w-5 text-gold flex-shrink-0" />
        </motion.button>
      )}

      {signals === null ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[62px] rounded-xl border border-parchment/10 bg-walnut/40 animate-pulse" />
          ))}
        </div>
      ) : cards.length > 0 ? (
        <div>
          <div className="mb-2 text-[10.5px] font-bold uppercase tracking-wider text-faded">Needs attention</div>
          <motion.div
            className="grid grid-cols-1 sm:grid-cols-2 gap-2.5"
            initial={prefersReducedMotion ? undefined : "hidden"}
            animate={prefersReducedMotion ? undefined : "shown"}
            transition={{ staggerChildren: stagger.tight }}
          >
            {cards.map((c) => <SignalCard key={c.testid} {...c} prefersReducedMotion={prefersReducedMotion} />)}
          </motion.div>
        </div>
      ) : (
        <p className="text-[12.5px] text-faded">Nothing needs attention right now.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 pt-2 border-t border-parchment/10">
        <PillRow icon={Clock} label="Recent" items={memory.recent} tabByKey={tabByKey}
                 onNavigate={onNavigate} emptyHint="Tools you open will show up here." testidPrefix="studio-home-recent" />
        <PillRow icon={TrendingUp} label="Frequent" items={memory.frequent} tabByKey={tabByKey}
                 onNavigate={onNavigate} emptyHint="Your most-used tools will show up here." testidPrefix="studio-home-frequent" />
        <PillRow icon={Star} label="Favorites" items={memory.favorites} tabByKey={tabByKey}
                 onNavigate={onNavigate} emptyHint="Pin a tool from any workspace to see it here." testidPrefix="studio-home-favorite" />
      </div>
    </div>
  );
}
