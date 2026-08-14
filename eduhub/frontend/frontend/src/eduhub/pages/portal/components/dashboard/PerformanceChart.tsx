// @ts-nocheck
import { motion, AnimatePresence } from "framer-motion";
import {
  LineChart as LineChartIcon,
  Trophy,
  MapPin,
  Triangle,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  Area,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
} from "recharts";
import { useMemo, useState } from "react";
import type { PerformanceHistoryItem } from "../../types";
import { Card } from "../primitives/Card";
import { LoadingState } from "../primitives/LoadingState";
import { HISTORY_SERIES } from "../../config/sections";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  history: PerformanceHistoryItem[] | null;
  loading: boolean;
}

type TabId = "trend" | "radar";

/* Inline EN/KM literals — copy.ts can't be modified per spec. */
const LABELS = {
  trend: { en: "Trend", km: "និន្នាការ" },
  radar: { en: "Radar", km: "ផ្កាយ" },
  best: { en: "Best", km: "ល្អបំផុត" },
  latest: { en: "Latest", km: "ថ្មីបំផុត" },
  change: { en: "Change", km: "ការប្រែប្រួល" },
};

const OVERALL_SERIES = HISTORY_SERIES.find((s) => s.key === "overallScore");
const OTHER_SERIES = HISTORY_SERIES.filter((s) => s.key !== "overallScore");

export function PerformanceChart({ history, loading }: Props) {
  const { t, lang } = useLang();
  const [tab, setTab] = useState<TabId>("trend");
  /** Single-criterion spotlight (besides Overall). null = show Overall alone. */
  const [spotlight, setSpotlight] = useState<string | null>(null);

  const data = useMemo(
    () =>
      (history || []).map((d) => ({
        ...d,
        label: new Date(d.date).toLocaleDateString(
          lang === "km" ? "km-KH" : "en-US",
          { month: "short", day: "numeric" },
        ),
      })),
    [history, lang],
  );

  /* ---------------- Stat row values ---------------- */
  const stats = useMemo(() => {
    const safe = history ?? [];
    if (safe.length === 0) {
      return { best: null, latest: null, change: null };
    }
    const best = safe.reduce(
      (m, x) => (x.overallScore > m ? x.overallScore : m),
      safe[0].overallScore,
    );
    const latest = safe[safe.length - 1].overallScore;
    const prev = safe.length > 1 ? safe[safe.length - 2].overallScore : null;
    const change = prev === null ? null : Number((latest - prev).toFixed(1));
    return { best, latest, change };
  }, [history]);

  /* ---------------- Radar dataset (latest item) ---------------- */
  const radarData = useMemo(() => {
    if (!history || history.length === 0) return [];
    const latest = history[history.length - 1];
    return OTHER_SERIES.map((s) => {
      const value = (latest as unknown as Record<string, number>)[s.key];
      return {
        criterion: lang === "km" ? s.nameKh : s.name,
        score: typeof value === "number" ? value : 0,
      };
    });
  }, [history, lang]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.35 }}
    >
      <Card className="p-5 sm:p-7" data-testid="performance-chart">
        <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div
              className="h-9 w-9 rounded-xl flex items-center justify-center text-[color:var(--color-surface)]"
              style={{ background: "var(--color-accent)" }}
            >
              <LineChartIcon className="h-4.5 w-4.5" />
            </div>
            <div>
              <h2 className="display text-lg font-bold text-[color:var(--color-ink)]">
                {t("history")}
              </h2>
              <p className="khmer text-xs text-[color:var(--color-ink-mute)]">
                ប្រវត្តិលទ្ធផល
              </p>
            </div>
          </div>

          {/* ---------------- Tab pill toggle ---------------- */}
          <div
            className="relative flex items-center rounded-full p-1 text-xs font-semibold"
            style={{
              background: "color-mix(in oklab, var(--color-line) 50%, transparent)",
            }}
            data-testid="chart-tab-switcher"
          >
            {(
              [
                { id: "trend" as const, label: LABELS.trend },
                { id: "radar" as const, label: LABELS.radar },
              ]
            ).map((entry) => {
              const active = tab === entry.id;
              return (
                <button
                  key={entry.id}
                  onClick={() => setTab(entry.id)}
                  className="relative px-4 py-1.5 rounded-full transition"
                  style={{
                    color: active
                      ? "var(--color-surface)"
                      : "var(--color-ink-soft)",
                  }}
                  data-testid={`chart-tab-${entry.id}`}
                >
                  {active && (
                    <motion.span
                      layoutId="chart-tab-indicator"
                      className="absolute inset-0 rounded-full"
                      style={{ background: "var(--color-accent)" }}
                      transition={{ type: "spring", stiffness: 320, damping: 28 }}
                    />
                  )}
                  <span className="relative z-10">
                    {lang === "km" ? entry.label.km : entry.label.en}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ---------------- Stat row (visible on Trend tab) ---------------- */}
        <AnimatePresence initial={false}>
          {tab === "trend" && stats.latest !== null && (
            <motion.div
              key="stat-row"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="flex flex-wrap gap-2 mt-4"
              data-testid="trend-stat-row"
            >
              <StatPill
                icon={<Trophy className="h-3.5 w-3.5" />}
                label={lang === "km" ? LABELS.best.km : LABELS.best.en}
                value={stats.best ?? 0}
                tone="warm"
                testid="stat-best"
              />
              <StatPill
                icon={<MapPin className="h-3.5 w-3.5" />}
                label={lang === "km" ? LABELS.latest.km : LABELS.latest.en}
                value={stats.latest}
                tone="accent"
                testid="stat-latest"
              />
              <ChangePill
                label={lang === "km" ? LABELS.change.km : LABELS.change.en}
                change={stats.change}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ---------------- Series toggles (Trend only) ---------------- */}
        {tab === "trend" && (
          <div className="flex flex-wrap gap-2 mt-4 mb-4">
            {OTHER_SERIES.map((s) => {
              const on = spotlight === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() =>
                    setSpotlight((curr) => (curr === s.key ? null : s.key))
                  }
                  className="text-xs font-semibold px-3 py-1.5 rounded-full border transition flex items-center gap-1.5"
                  style={
                    on
                      ? {
                          background: s.color,
                          borderColor: s.color,
                          color: "var(--color-surface)",
                        }
                      : {
                          background: "transparent",
                          borderColor: "var(--color-line)",
                          color: "var(--color-ink-soft)",
                        }
                  }
                  data-testid={`series-toggle-${s.key}`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: on ? "#fff" : s.color }}
                  />
                  {lang === "km" ? s.nameKh : s.name}
                </button>
              );
            })}
          </div>
        )}

        {/* ---------------- Chart body ---------------- */}
        <div className="h-72 w-full mt-4">
          {loading ? (
            <LoadingState label={t("loadingHistory")} variant="block" />
          ) : data.length === 0 ? (
            <div className="h-full flex items-center justify-center text-[color:var(--color-ink-mute)] text-sm">
              {t("noHistory")}
            </div>
          ) : tab === "trend" ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={data}
                margin={{ top: 8, right: 16, left: -12, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="overallFill" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor={OVERALL_SERIES?.color ?? "#1F4E4A"}
                      stopOpacity={0.32}
                    />
                    <stop
                      offset="100%"
                      stopColor={OVERALL_SERIES?.color ?? "#1F4E4A"}
                      stopOpacity={0.02}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                <XAxis
                  dataKey="label"
                  stroke="var(--color-ink-soft)"
                  fontSize={11}
                />
                <YAxis
                  domain={[0, 10]}
                  stroke="var(--color-ink-soft)"
                  fontSize={11}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-ink)",
                    border: "none",
                    borderRadius: 12,
                    color: "var(--color-surface)",
                    fontSize: 12,
                  }}
                  labelStyle={{
                    color: "var(--color-accent-warm)",
                    fontWeight: 700,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="overallScore"
                  stroke="none"
                  fill="url(#overallFill)"
                  fillOpacity={1}
                  isAnimationActive={false}
                />
                {/* Hero Overall line */}
                {OVERALL_SERIES && (
                  <Line
                    type="monotone"
                    dataKey="overallScore"
                    name={
                      lang === "km" ? OVERALL_SERIES.nameKh : OVERALL_SERIES.name
                    }
                    stroke={OVERALL_SERIES.color}
                    strokeWidth={3}
                    dot={{ r: 3, strokeWidth: 0, fill: OVERALL_SERIES.color }}
                    activeDot={{ r: 5 }}
                    animationDuration={900}
                  />
                )}
                {/* Spotlit criterion (when active) */}
                {spotlight &&
                  (() => {
                    const s = OTHER_SERIES.find((x) => x.key === spotlight);
                    if (!s) return null;
                    return (
                      <Line
                        key={s.key}
                        type="monotone"
                        dataKey={s.key}
                        name={lang === "km" ? s.nameKh : s.name}
                        stroke={s.color}
                        strokeWidth={2.5}
                        dot={{ r: 3, strokeWidth: 0, fill: s.color }}
                        activeDot={{ r: 5 }}
                        animationDuration={900}
                      />
                    );
                  })()}
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            /* ----- Radar tab ----- */
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart
                data={radarData}
                margin={{ top: 8, right: 16, left: 16, bottom: 8 }}
                outerRadius="78%"
              >
                <PolarGrid stroke="var(--color-line)" />
                <PolarAngleAxis
                  dataKey="criterion"
                  tick={{
                    fill: "var(--color-ink-soft)",
                    fontSize: 11,
                  }}
                />
                <PolarRadiusAxis
                  domain={[0, 10]}
                  tick={{ fill: "var(--color-ink-mute)", fontSize: 10 }}
                  stroke="var(--color-line)"
                />
                <Radar
                  name="latest"
                  dataKey="score"
                  stroke="var(--color-accent)"
                  fill="var(--color-accent)"
                  fillOpacity={0.25}
                  isAnimationActive
                  animationDuration={700}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-ink)",
                    border: "none",
                    borderRadius: 12,
                    color: "var(--color-surface)",
                    fontSize: 12,
                  }}
                  labelStyle={{
                    color: "var(--color-accent-warm)",
                    fontWeight: 700,
                  }}
                />
              </RadarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Hidden helper to keep LineChart import in case of tree-shaking quirks. */}
        {false && <LineChart data={[]} />}
      </Card>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Stat pill primitives                                                       */
/* -------------------------------------------------------------------------- */

interface StatPillProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "warm" | "accent";
  testid: string;
}

function StatPill({ icon, label, value, tone, testid }: StatPillProps) {
  const bg =
    tone === "warm"
      ? "color-mix(in oklab, var(--color-accent-warm) 22%, transparent)"
      : "color-mix(in oklab, var(--color-accent) 14%, transparent)";
  const fg =
    tone === "warm" ? "var(--color-accent-warm)" : "var(--color-accent)";
  return (
    <div
      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold"
      style={{ background: bg, color: fg }}
      data-testid={testid}
    >
      {icon}
      <span className="text-[color:var(--color-ink-soft)] uppercase tracking-wide">
        {label}
      </span>
      <span className="display tnum text-sm" style={{ color: fg }}>
        {value.toFixed(1)}
      </span>
    </div>
  );
}

function ChangePill({
  label,
  change,
}: {
  label: string;
  change: number | null;
}) {
  let symbol = "━";
  let color = "var(--color-ink-mute)";
  let bg = "color-mix(in oklab, var(--color-line) 60%, transparent)";
  let display = "—";
  if (change !== null) {
    if (change > 0) {
      symbol = "↑";
      color = "var(--color-excellent)";
      bg = "color-mix(in oklab, var(--color-excellent) 18%, transparent)";
      display = `+${change.toFixed(1)}`;
    } else if (change < 0) {
      symbol = "↓";
      color = "var(--color-needs)";
      bg = "color-mix(in oklab, var(--color-needs) 18%, transparent)";
      display = change.toFixed(1);
    } else {
      display = "0.0";
    }
  }
  return (
    <div
      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold"
      style={{ background: bg, color }}
      data-testid="stat-change"
    >
      <Triangle className="h-3 w-3" />
      <span className="text-[color:var(--color-ink-soft)] uppercase tracking-wide">
        {label}
      </span>
      <span className="display tnum text-sm" style={{ color }}>
        {symbol} {display}
      </span>
    </div>
  );
}
