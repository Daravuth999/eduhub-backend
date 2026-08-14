import { memo, useMemo, useState } from "react";
import { Check, X, Sparkles } from "lucide-react";

/**
 * ExerciseBlock — universal renderer for interactive exercises inside
 * a book (v7.9.8). Instructors author these from the sheet as block
 * rows with one of the new types:
 *
 *   { type: 'mcq',       text: "Question?", options: "A|B|C|D", answer: "B", explain? }
 *   { type: 'fillblank', text: "I ___ to school.", answer: "go",           explain? }
 *
 * `options` is split on "|" so the sheet author can keep everything in
 * a single cell. `answer` is compared case-insensitively and
 * whitespace-trimmed for fill-in-the-blank — forgiving but still
 * distinct answers.
 *
 * Scoring is local only — the score is pushed into the existing
 * `completeLesson` API via a new optional `onScore` callback provided
 * by the reader page. No new backend endpoint.
 */
const ExerciseBlock = memo(function ExerciseBlock({ block, onAnswer }) {
  const type = (block?.type || "").toLowerCase();
  if (type === "mcq") return <MCQ block={block} onAnswer={onAnswer} />;
  if (type === "fillblank") return <FillBlank block={block} onAnswer={onAnswer} />;
  return null;
});

function MCQ({ block, onAnswer }) {
  const opts = useMemo(() => splitOptions(block.options), [block.options]);
  const correct = String(block.answer || "").trim();
  const [picked, setPicked] = useState(null);

  if (!block.text || !opts.length || !correct) {
    return (
      <p className="exercise-block__error">
        Malformed MCQ — missing text / options / answer.
      </p>
    );
  }

  const revealed = picked !== null;
  const isCorrect = revealed && matchesAnswer(picked, correct);

  return (
    <section
      className="exercise-block exercise-block--mcq"
      data-state={revealed ? (isCorrect ? "correct" : "wrong") : "idle"}
      data-testid="exercise-mcq"
    >
      <p className="exercise-block__question">{block.text}</p>
      <ul className="exercise-block__options">
        {opts.map((opt, i) => {
          const chosen = picked === opt;
          const isAns = revealed && matchesAnswer(opt, correct);
          return (
            <li key={i}>
              <button
                type="button"
                disabled={revealed}
                onClick={() => {
                  setPicked(opt);
                  onAnswer?.(matchesAnswer(opt, correct));
                }}
                data-chosen={chosen ? "true" : "false"}
                data-answer={isAns ? "true" : "false"}
                data-testid={`exercise-mcq-option-${i}`}
              >
                <span className="exercise-block__bullet">
                  {revealed ? (
                    isAns ? (
                      <Check className="h-3 w-3" strokeWidth={3} />
                    ) : chosen ? (
                      <X className="h-3 w-3" strokeWidth={3} />
                    ) : (
                      String.fromCharCode(65 + i)
                    )
                  ) : (
                    String.fromCharCode(65 + i)
                  )}
                </span>
                <span>{stripLetterPrefix(opt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {revealed && (
        <p
          className="exercise-block__explain"
          data-correct={isCorrect ? "true" : "false"}
        >
          {isCorrect ? (
            <>
              <Sparkles className="h-3 w-3" /> Correct!
            </>
          ) : (
            <>Answer: <strong>{correct}</strong></>
          )}
          {block.explain ? ` — ${block.explain}` : ""}
        </p>
      )}
    </section>
  );
}

function FillBlank({ block, onAnswer }) {
  const correct = String(block.answer || "").trim();
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);

  if (!block.text || !correct) {
    return (
      <p className="exercise-block__error">
        Malformed fill-in-the-blank — missing text / answer.
      </p>
    );
  }

  const parts = block.text.split(/_{2,}|…|\.{3,}|\[blank\]/i);
  const isCorrect = submitted && matchesAnswer(value, correct);

  return (
    <section
      className="exercise-block exercise-block--fill"
      data-state={submitted ? (isCorrect ? "correct" : "wrong") : "idle"}
      data-testid="exercise-fillblank"
    >
      <p className="exercise-block__question">
        {parts[0]}
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={submitted}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="exercise-block__input"
          data-testid="exercise-fillblank-input"
          aria-label="Your answer"
        />
        {parts.slice(1).join("___")}
      </p>
      {!submitted ? (
        <button
          type="button"
          className="exercise-block__submit"
          disabled={!value.trim()}
          onClick={() => {
            setSubmitted(true);
            onAnswer?.(matchesAnswer(value, correct));
          }}
          data-testid="exercise-fillblank-submit"
        >
          Check answer
        </button>
      ) : (
        <p
          className="exercise-block__explain"
          data-correct={isCorrect ? "true" : "false"}
        >
          {isCorrect ? (
            <>
              <Sparkles className="h-3 w-3" /> Correct!
            </>
          ) : (
            <>Correct answer: <strong>{correct}</strong></>
          )}
          {block.explain ? ` — ${block.explain}` : ""}
        </p>
      )}
    </section>
  );
}

/* --------- helpers --------- */

/**
 * splitOptions — accept any of the three common author input formats:
 *   1. Array (passed from Studio/JSON)
 *   2. Newline-separated (Studio placeholder: "One per line, e.g. A) text")
 *   3. Pipe-separated (legacy sheet format — preserved for back-compat)
 *   4. Semicolon-separated (common human paste)
 *
 * Whitespace around each option is trimmed; empty lines are dropped.
 */
function splitOptions(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/\r?\n|\s*\|\s*|\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * stripLetterPrefix — remove a leading label like "A)", "B.", "c-" so the
 * bullet letter rendered by the UI isn't doubled on screen. The stored
 * option text (used for answer matching) still retains the original
 * string so letter-based answers keep working.
 */
function stripLetterPrefix(text) {
  return String(text).replace(/^\s*[A-Za-z][\)\.\:\-]\s*/, "").trim();
}

/**
 * matchesAnswer — forgiving comparison between the student's pick and
 * the author-defined correct answer.
 *   • If the author provided a single letter ("B"), we extract the
 *     leading letter from the picked option ("B) Calm and excited" → "B")
 *     and compare letter-to-letter.
 *   • Otherwise fall back to the original full-text case-insensitive
 *     comparison (unchanged behaviour for fill-in-the-blank and for
 *     authors who provided the full option text as the answer).
 */
function matchesAnswer(picked, correct) {
  const p = String(picked || "").trim();
  const c = String(correct || "").trim();
  if (!p || !c) return false;
  if (/^[A-Za-z]$/.test(c)) {
    const m = p.match(/^\s*([A-Za-z])[\)\.\:\-]/);
    if (m) return m[1].toLowerCase() === c.toLowerCase();
  }
  return p.toLowerCase() === c.toLowerCase();
}

export default ExerciseBlock;
