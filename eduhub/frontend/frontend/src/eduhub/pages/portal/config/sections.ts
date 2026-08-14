import {
  Mic,
  Music2,
  MessageCircle,
  Hand,
  Waves,
  Link2,
  ThumbsUp,
  AlertTriangle,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";
import type { CriterionKey } from "../types";

/* -------------------------------------------------------------------------- */
/*  ONE config file for sections — change a label, icon, color, or threshold   */
/*  here and it propagates everywhere. (Your code-structure rule.)            */
/* -------------------------------------------------------------------------- */

export const PALETTE = {
  bg: "var(--color-bg)",
  surface: "var(--color-surface)",
  surface2: "var(--color-surface-2)",
  ink: "var(--color-ink)",
  inkSoft: "var(--color-ink-soft)",
  line: "var(--color-line)",
  accent: "var(--color-accent)",
  accentWarm: "var(--color-accent-warm)",
  excellent: "var(--color-excellent)",
  good: "var(--color-good)",
  needs: "var(--color-needs)",
} as const;

export const TIER_THRESHOLDS = [
  { min: 8, key: "excellent", color: PALETTE.excellent },
  { min: 6, key: "good", color: PALETTE.good },
  { min: 0, key: "needs", color: PALETTE.needs },
] as const;

export const TOP_PERFORMER_THRESHOLD = 8.5;
export const EXCELLENT_THRESHOLD = 8.0;

/* Background polling cadences */
export const POLL_RESTRICTION_MS = 15_000; // 15s — matches AuthContext watchdog
// v7.9.3 — unified 3-second forced sign-out across the entire portal.
export const RESTRICTION_LOGOUT_COUNTDOWN = 3; // seconds before forced sign-out
export const POLL_POINTS_MS = 12_000; // 12s — points balance refresh (snappy)
export const IDLE_LOGOUT_MS = 20 * 60_000; // 20 min idle

/* -------------------------------------------------------------------------- */
/*  Points-received celebration tiers — escalating dopamine.                   */
/*  Any positive balance change triggers a tier; source is irrelevant.        */
/* -------------------------------------------------------------------------- */
export type PointsTier = "tiny" | "nice" | "big" | "huge";

export const POINTS_TIERS: { min: number; key: PointsTier }[] = [
  { min: 200, key: "huge" },
  { min: 50, key: "big" },
  { min: 10, key: "nice" },
  { min: 1, key: "tiny" },
];

export function classifyPointsDelta(delta: number): PointsTier | null {
  if (delta < 1) return null;
  for (const t of POINTS_TIERS) if (delta >= t.min) return t.key;
  return null;
}

/* The 6 evaluation criteria */
export interface CriterionConfig {
  key: CriterionKey;
  label: string;
  labelKh: string;
  icon: LucideIcon;
  /** Plain-language description used in the "why is my score this?" drawer. */
  description: string;
  descriptionKh: string;
}

export const CRITERIA: readonly CriterionConfig[] = [
  {
    key: "pronunciation",
    label: "Pronunciation",
    labelKh: "ការបញ្ចេញសំឡេង",
    icon: Mic,
    description:
      "How clearly you pronounce individual sounds and words. Practise tricky vowels and consonants out loud.",
    descriptionKh:
      "តើអ្នកបញ្ចេញសំឡេងនិងពាក្យបានច្បាស់ប៉ុណ្ណា។ សូមហ្វឹកហាត់ស្រៈនិងព្យញ្ជនៈពិបាកៗឱ្យបានច្រើន។",
  },
  {
    key: "intonation",
    label: "Intonation",
    labelKh: "សំឡេងឡើងចុះ",
    icon: Music2,
    description:
      "The melody of your voice — how it rises and falls naturally. Mimic how natives speak by listening and repeating.",
    descriptionKh:
      "ឆាកសំឡេងរបស់អ្នកដែលឡើងនិងធ្លាក់ចុះតាមធម្មជាតិ។ ចម្លងតាមការនិយាយរបស់ជនជាតិដើម។",
  },
  {
    key: "communication",
    label: "Communication",
    labelKh: "ការទំនាក់ទំនង",
    icon: MessageCircle,
    description:
      "Whether your message is understood by the listener. Aim for clarity, eye-contact, and steady pace.",
    descriptionKh:
      "តើសារដែលអ្នកប្រាប់អ្នកស្តាប់យល់ច្បាស់ឬទេ។ រក្សាការប្រាស្រ័យទាក់ទងភ្នែកនិងល្បឿននិយាយត្រឹមត្រូវ។",
  },
  {
    key: "participation",
    label: "Participation",
    labelKh: "ការចូលរួម",
    icon: Hand,
    description:
      "How actively you join in class — asking questions, answering, and helping classmates.",
    descriptionKh:
      "កម្រិតនៃការចូលរួមរបស់អ្នកក្នុងថ្នាក់ — សួរសំណួរ ឆ្លើយតប និងជួយមិត្តរួមថ្នាក់។",
  },
  {
    key: "risingFalling",
    label: "Rising & Falling",
    labelKh: "ស្នូរ​ឡើង​ចុះ",
    icon: Waves,
    description:
      "The pitch pattern of questions vs. statements. Rising tones for questions, falling for declarations.",
    descriptionKh:
      "លំនាំសំឡេងសម្រាប់សំណួរនិងសេចក្តីប្រកាស។ សំឡេងឡើងសម្រាប់សំណួរ ធ្លាក់ចុះសម្រាប់សេចក្តីប្រកាស។",
  },
  {
    key: "linkingSounds",
    label: "Linking Sounds",
    labelKh: "ការតភ្ជាប់សំឡេង",
    icon: Link2,
    description:
      "Connecting words smoothly so speech flows. e.g. 'turn on' → 'turn-on', 'an apple' → 'an-apple'.",
    descriptionKh:
      "ការតភ្ជាប់ពាក្យឱ្យហូរលឿន ដូចជា 'turn on' → 'turn-on'។",
  },
];

/* Strength / Weakness / Improvement triad — keys map to StudentData */
export const FEEDBACK_CARDS = [
  {
    key: "Strength" as const,
    title: "Strengths",
    titleKh: "ចំណុចខ្លាំង",
    icon: ThumbsUp,
    tone: "excellent" as const,
  },
  {
    key: "Weakness" as const,
    title: "Areas to Watch",
    titleKh: "ចំណុចខ្សោយ",
    icon: AlertTriangle,
    tone: "needs" as const,
  },
  {
    key: "Improvement" as const,
    title: "How to Improve",
    titleKh: "របៀបកែលម្អ",
    icon: Lightbulb,
    tone: "accent" as const,
  },
];

/* Score guide modal rows */
export const SCORE_GUIDE_ROWS = [
  {
    range: "8.0 – 10",
    label: "Excellent",
    labelKh: "ល្អឥតខ្ចោះ",
    color: PALETTE.excellent,
    desc: "Outstanding performance — keep up the excellent work!",
    descKh: "សមត្ថភាពល្អឥតខ្ចោះ — បន្តដូចនេះតទៅ!",
  },
  {
    range: "6.0 – 7.9",
    label: "Good",
    labelKh: "ល្អ",
    color: PALETTE.good,
    desc: "Solid progress — push a little harder to reach excellence.",
    descKh: "មានការជឿនលឿន — សូមខំប្រឹងបន្តិចទៀត។",
  },
  {
    range: "0 – 5.9",
    label: "Needs Work",
    labelKh: "ត្រូវខិតខំ",
    color: PALETTE.needs,
    desc: "Focus and practise — your teacher will help you improve.",
    descKh: "សូមផ្តោតនិងហ្វឹកហាត់ — គ្រូនឹងជួយអ្នក។",
  },
];

/* Recharts series for the performance history chart */
export const HISTORY_SERIES = [
  { key: "overallScore", name: "Overall", nameKh: "សរុប", color: "#1F4E4A" },
  {
    key: "pronunciation",
    name: "Pronunciation",
    nameKh: "បញ្ចេញ",
    color: "#2F7D5A",
  },
  {
    key: "intonation",
    name: "Intonation",
    nameKh: "ឡើងចុះ",
    color: "#C8941A",
  },
  {
    key: "communication",
    name: "Communication",
    nameKh: "ទំនាក់ទំនង",
    color: "#C77B5C",
  },
  {
    key: "participation",
    name: "Participation",
    nameKh: "ចូលរួម",
    color: "#7A5DC7",
  },
  {
    key: "risingFalling",
    name: "Rising/Falling",
    nameKh: "ស្នូរ",
    color: "#5BB0B0",
  },
  {
    key: "linkingSounds",
    name: "Linking",
    nameKh: "តភ្ជាប់",
    color: "#B14B3A",
  },
] as const;
