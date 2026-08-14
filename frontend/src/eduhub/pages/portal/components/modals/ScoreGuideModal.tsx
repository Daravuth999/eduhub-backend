import { useEffect } from "react";
import { BookOpen } from "lucide-react";
import { ModalShell } from "../primitives/ModalShell";
import { SCORE_GUIDE_ROWS } from "../../config/sections";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ScoreGuideModal({ open, onClose }: Props) {
  const { t, lang } = useLang();

  // Auto-close after 20s (existing behaviour preserved).
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(onClose, 20000);
    return () => clearTimeout(timer);
  }, [open, onClose]);

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={t("scoreGuide")}
      subtitle={lang === "km" ? "មគ្គុទ្ទេសក៏ពិន្ទុ" : "Understand your scores"}
      icon={BookOpen}
      testId="score-guide-modal"
    >
      <div className="p-5 sm:p-6 space-y-3">
        {SCORE_GUIDE_ROWS.map((r) => (
          <div
            key={r.label}
            className="flex gap-4 items-start rounded-2xl border p-4 ink-shadow"
            style={{
              borderColor: "var(--color-line)",
              borderLeftWidth: 6,
              borderLeftColor: r.color,
              background: "var(--color-surface-2)",
            }}
            data-testid={`score-row-${r.label.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <div className="text-center min-w-[64px]">
              <div
                className="display tnum text-base font-bold"
                style={{ color: r.color }}
              >
                {r.range}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-ink-mute)] mt-1">
                Score
              </div>
            </div>
            <div className="flex-1">
              <div className="font-bold text-[color:var(--color-ink)]">
                {r.label}{" "}
                <span className="khmer font-semibold text-[color:var(--color-ink-soft)] text-sm">
                  · {r.labelKh}
                </span>
              </div>
              <p className="text-sm text-[color:var(--color-ink-soft)] mt-0.5 leading-relaxed">
                {lang === "km" ? r.descKh : r.desc}
              </p>
            </div>
          </div>
        ))}
        <p className="text-xs text-center text-[color:var(--color-ink-mute)] pt-2">
          {t("scoreGuideAutoClose")}
        </p>
      </div>
    </ModalShell>
  );
}
