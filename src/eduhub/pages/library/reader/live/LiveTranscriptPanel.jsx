/**
 * LiveTranscriptPanel.jsx — live transcript feed (student + coach turns).
 *
 * v1.5 — readable utterance-level rendering.
 *
 * The parent component (EduTalkLiveCoach) now coalesces Gemini's streaming
 * token deltas into utterance-level blocks. Each line we receive already
 * contains a full readable sentence/paragraph for that turn, so all this
 * component has to do is render them clearly with proper labels, sane
 * line-wrapping, Khmer-friendly fonts, and an auto-scroll to the latest
 * turn. The component is intentionally simple — it does NOT mutate the
 * lines array.
 *
 * Optional fields supported (forward-compatible, no backend change yet):
 *   - role: "student" | "coach"
 *   - kind: "practice" | "feedback" | undefined  (rendered as labels)
 *   - text: string
 */
import { useEffect, useRef } from "react";

const LABEL = {
  student: "You",
  coach: "Coach",
};

const KIND_LABEL = {
  practice: "Practice sentence",
  feedback: "Feedback",
};

export default function LiveTranscriptPanel({ lines = [] }) {
  const endRef = useRef(null);
  const lastLineText = lines.length ? lines[lines.length - 1]?.text : "";
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines.length, lastLineText]);

  return (
    <div className="etlc-transcript" data-testid="live-transcript">
      {lines.length === 0 ? (
        <div className="etlc-transcript__empty">
          Your conversation will appear here as you speak…
        </div>
      ) : (
        lines.map((l, i) => {
          const role = l.role === "student" ? "student" : "coach";
          const kindLabel = l.kind ? KIND_LABEL[l.kind] : null;
          const label = kindLabel || LABEL[role];
          return (
            <div
              key={i}
              className={`etlc-line is-${role}${l.kind ? " is-" + l.kind : ""}`}
              data-testid={`live-line-${role}`}
            >
              <div className="etlc-line__who">{label}</div>
              <div className="etlc-line__text">{l.text}</div>
            </div>
          );
        })
      )}
      <div ref={endRef} />
    </div>
  );
}
