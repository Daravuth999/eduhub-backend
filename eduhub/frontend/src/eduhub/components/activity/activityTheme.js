/**
 * activityTheme.js — shared visual tokens for the Activity Center™.
 * Priority + category styling in one place so the bell, drawer, timeline,
 * Cathy assistant and live strip stay perfectly consistent.
 */
import {
  AlertTriangle, Award, BadgeDollarSign, BookOpen, CalendarCheck2,
  Coins, Gift, Info, Mic2, Ticket,
} from "lucide-react";

export const PRIORITY_STYLES = {
  critical: {
    label: "Critical",
    accent: "#ff5470",
    bg: "rgba(255,84,112,0.10)",
    ring: "rgba(255,84,112,0.45)",
  },
  important: {
    label: "Important",
    accent: "#ffc94d",
    bg: "rgba(255,201,77,0.10)",
    ring: "rgba(255,201,77,0.45)",
  },
  achievement: {
    label: "Achievement",
    accent: "#a3ff3a",
    bg: "rgba(163,255,58,0.10)",
    ring: "rgba(163,255,58,0.40)",
  },
  normal: {
    label: "Update",
    accent: "#00e0ff",
    bg: "rgba(0,224,255,0.08)",
    ring: "rgba(0,224,255,0.35)",
  },
};

export const CATEGORY_META = {
  all:          { label: "All",          icon: Info },
  rewards:      { label: "Rewards",      icon: Gift },
  points:       { label: "Points",       icon: Coins },
  vouchers:     { label: "Vouchers",     icon: Ticket },
  payments:     { label: "Payments",     icon: BadgeDollarSign },
  classes:      { label: "Classes",      icon: BookOpen },
  speaking_lab: { label: "Speaking Lab", icon: Mic2 },
  attendance:   { label: "Attendance",   icon: CalendarCheck2 },
  system:       { label: "System",       icon: Info },
};

export const CATEGORY_ORDER = [
  "all", "rewards", "points", "vouchers", "payments",
  "classes", "speaking_lab", "attendance", "system",
];

export function priorityStyle(priority) {
  return PRIORITY_STYLES[priority] || PRIORITY_STYLES.normal;
}

export function categoryIcon(category, priority) {
  if (priority === "critical") return AlertTriangle;
  if (priority === "achievement") return Award;
  return (CATEGORY_META[category] || CATEGORY_META.system).icon;
}

/** Relative "2m · 3h · Mon" style timestamp. */
export function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Group items into Today / Yesterday / Older buckets (input pre-sorted desc). */
export function groupByDay(items) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today.getTime() - 86400000);
  const buckets = { Today: [], Yesterday: [], Older: [] };
  for (const it of items) {
    const d = new Date(it.createdAt);
    if (d >= today) buckets.Today.push(it);
    else if (d >= yesterday) buckets.Yesterday.push(it);
    else buckets.Older.push(it);
  }
  return buckets;
}
