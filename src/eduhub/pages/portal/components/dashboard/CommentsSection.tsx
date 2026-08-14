import { motion } from "framer-motion";
import { MessageSquare, Quote } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CommentItem } from "../../types";
import { Card } from "../primitives/Card";
import { Pill } from "../primitives/Pill";
import { LoadingState } from "../primitives/LoadingState";
import { useLang } from "../../contexts/LanguageContext";
import { useNewComments } from "../../hooks/useNewComments";

interface Props {
  studentId: string;
  comments: CommentItem[] | null;
  loading: boolean;
}

function toneFor(type?: string): "excellent" | "good" | "accent" {
  if (type === "positive") return "excellent";
  if (type === "improvement") return "good";
  return "accent";
}

export function CommentsSection({ studentId, comments, loading }: Props) {
  const { t } = useLang();
  const { hasNew, markSeen } = useNewComments(studentId, comments);
  const ref = useRef<HTMLDivElement>(null);

  // Mark seen once the section scrolls into view.
  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          markSeen();
          obs.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [markSeen]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
      ref={ref}
    >
      <Card className="p-5 sm:p-7" data-testid="comments-section">
        <div className="flex items-center gap-2.5 mb-5">
          <div
            className="h-9 w-9 rounded-xl flex items-center justify-center text-[color:var(--color-surface)]"
            style={{ background: "var(--color-accent-warm)" }}
          >
            <MessageSquare className="h-4.5 w-4.5" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="display text-lg font-bold text-[color:var(--color-ink)]">
                {t("teacherComments")}
              </h2>
              {hasNew && (
                <Pill tone="warm" filled data-testid="comments-new-pill">
                  {t("newPill")}
                </Pill>
              )}
            </div>
            <p className="khmer text-xs text-[color:var(--color-ink-mute)]">
              មតិយោបល់ពីគ្រូ
            </p>
          </div>
        </div>

        {loading ? (
          <LoadingState label={t("loadingComments")} variant="block" />
        ) : !comments || comments.length === 0 ? (
          <div className="text-center py-10 text-[color:var(--color-ink-mute)]">
            <Quote className="h-7 w-7 mx-auto mb-2 opacity-40" />
            <p className="text-sm">{t("noComments")}</p>
          </div>
        ) : (
          <div className="space-y-3 max-h-96 overflow-y-auto pr-1 -mr-1">
            {comments.map((c, i) => {
              const tone = toneFor(c.type);
              const text = c.comment || c.text || "";
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.04 }}
                  className="rounded-xl border p-4 bg-[color:var(--color-surface-2)] border-[color:var(--color-line)]"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                    <div className="font-semibold text-sm text-[color:var(--color-ink)]">
                      {c.teacherName || "Teacher"}
                    </div>
                    <div className="flex items-center gap-2">
                      <Pill tone={tone}>{(c.type ?? "Note").toUpperCase()}</Pill>
                      {c.date && (
                        <span className="text-[11px] text-[color:var(--color-ink-mute)] mono">
                          {c.date}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-[color:var(--color-ink)] leading-relaxed whitespace-pre-line">
                    {text}
                  </p>
                </motion.div>
              );
            })}
          </div>
        )}
      </Card>
    </motion.div>
  );
}
