import { motion } from "framer-motion";
import type { StudentData } from "../../types";
import { FEEDBACK_CARDS } from "../../config/sections";
import { Card } from "../primitives/Card";
import { useLang } from "../../contexts/LanguageContext";

interface Props {
  student: StudentData;
}

const TONE_VAR: Record<string, string> = {
  excellent: "var(--color-excellent)",
  needs: "var(--color-needs)",
  accent: "var(--color-accent)",
};

export function FeedbackTriad({ student }: Props) {
  const { lang } = useLang();
  return (
    <motion.section
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, delay: 0.25 }}
      className="grid grid-cols-1 md:grid-cols-3 gap-4"
    >
      {FEEDBACK_CARDS.map((c, i) => {
        const Icon = c.icon;
        const value = (student[c.key] as string) || "—";
        const color = TONE_VAR[c.tone];
        return (
          <motion.div
            key={c.key}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.3 + i * 0.07 }}
          >
            <Card
              className="p-5 h-full"
              accentEdge={color}
              data-testid={`feedback-${c.key.toLowerCase()}`}
            >
              <div className="flex items-center gap-2.5 mb-3">
                <div
                  className="h-9 w-9 rounded-xl flex items-center justify-center text-[color:var(--color-surface)]"
                  style={{ background: color }}
                >
                  <Icon className="h-4.5 w-4.5" />
                </div>
                <div>
                  <h3
                    className={`font-bold text-sm ${lang === "km" ? "khmer" : "display"}`}
                    style={{ color }}
                  >
                    {lang === "km" ? c.titleKh : c.title}
                  </h3>
                  <p
                    className={`text-[11px] text-[color:var(--color-ink-mute)] ${
                      lang === "km" ? "" : "khmer"
                    }`}
                  >
                    {lang === "km" ? c.title : c.titleKh}
                  </p>
                </div>
              </div>
              <p className="text-sm leading-relaxed text-[color:var(--color-ink)] whitespace-pre-line">
                {value}
              </p>
            </Card>
          </motion.div>
        );
      })}
    </motion.section>
  );
}
