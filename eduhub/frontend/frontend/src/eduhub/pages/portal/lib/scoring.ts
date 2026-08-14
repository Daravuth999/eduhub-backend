import type { Scores, StudentData } from "../types";

export function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function extractScores(d: StudentData): Scores {
  return {
    pronunciation: num(d.Pronunciation),
    intonation: num(d.Intonation),
    communication: num(d.Communication),
    participation: num(d.Participation),
    risingFalling: num(d["Rising & Falling"]),
    linkingSounds: num(d["Linking Sounds"]),
  };
}

export function overallScore(s: Scores): number {
  const total =
    s.pronunciation +
    s.intonation +
    s.communication +
    s.participation +
    s.risingFalling +
    s.linkingSounds;
  return total / 6;
}

export interface Tier {
  level: "excellent" | "good" | "needs";
  label: string;
  labelKh: string;
  hex: string;
  cssVar: string;
}

export function getTier(score: number): Tier {
  if (score >= 8)
    return {
      level: "excellent",
      label: "Excellent",
      labelKh: "ល្អឥតខ្ចោះ",
      hex: "#2F7D5A",
      cssVar: "var(--color-excellent)",
    };
  if (score >= 6)
    return {
      level: "good",
      label: "Good",
      labelKh: "ល្អ",
      hex: "#C8941A",
      cssVar: "var(--color-good)",
    };
  return {
    level: "needs",
    label: "Needs Work",
    labelKh: "ត្រូវខិតខំ",
    hex: "#B14B3A",
    cssVar: "var(--color-needs)",
  };
}

export function isTopPerformer(overall: number) {
  return overall >= 8.5;
}

export function avatarUrl(name: string) {
  const safe = encodeURIComponent(name || "Student");
  // Background uses the Scholar's Notebook teal; foreground is cream.
  return `https://ui-avatars.com/api/?name=${safe}&background=1F4E4A&color=F4EFE3&size=256&font-size=0.4&bold=true`;
}

export function daysUntil(dateStr?: string): number | null {
  if (!dateStr) return null;
  const due = new Date(dateStr);
  if (isNaN(due.getTime())) return null;
  const now = new Date();
  const diff = due.getTime() - now.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export function formatDate(dateStr?: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/* Parse a date that may be a string or already a Date — defensive. */
export function parseDate(v?: string | number | Date | null): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
