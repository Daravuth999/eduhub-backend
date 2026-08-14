/**
 * StudioSmartPaste — markdown/prose paste box → parsed preview → apply.
 *
 * Calls `/api/studio/parse` with the raw text, shows what the parser
 * produced (chapter count, block-type counts), and lets the author
 * *append* it to the editor or replace the entire book.
 */
import { useState } from "react";
import { Sparkles, Loader2, CheckCircle2 } from "lucide-react";
import { parseRaw } from "./api";

const SAMPLE = `## Chapter 1

Once upon a time in a quiet village, a young girl found a mysterious book.

She opened it, and words began to glow.

### A warning appeared

> Read me only if you dare.

Teacher: What would you do?
Student: I would read it!

Q: Which is the main theme of this story?
A) Bravery
*B) Curiosity
C) Friendship

audio: https://example.com/ch1.mp3

[0.0 - 4.2] Once upon a time in a quiet village.
`;

export default function StudioSmartPaste({ onApply }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const run = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await parseRaw(text);
      setParsed(res);
    } catch (e) {
      setErr(e.message || "Parse failed");
    } finally {
      setLoading(false);
    }
  };

  const apply = (mode) => {
    if (!parsed) return;
    onApply?.({ chapters: parsed.chapters, mode });
    setText("");
    setParsed(null);
  };

  return (
    <div className="space-y-4" data-testid="studio-smart-paste">
      <div className="rounded-2xl border border-gold/20 p-4" style={{ background: "rgba(34,24,48,0.6)" }}>
        <p className="font-display text-[16px] text-parchment mb-2">Smart paste</p>
        <p className="text-[12px] text-faded mb-3 leading-relaxed">
          Paste any markdown, plain prose, or mixed content. The parser auto-detects
          <span className="text-gold"> chapters, headings, quotes, MCQs, fill-blanks, dialog, media and transcripts.</span>
        </p>
        <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)}
                  placeholder={SAMPLE}
                  className="w-full rounded-lg border border-parchment/15 bg-black/30 px-3 py-2 text-[12px] text-parchment outline-none focus:border-gold resize-y font-mono"
                  data-testid="studio-smart-paste-textarea" />
        <div className="mt-3 flex items-center gap-2">
          <button onClick={run} disabled={loading || !text.trim()}
                  data-testid="studio-smart-paste-parse"
                  className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink disabled:opacity-60"
                  style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {loading ? "Parsing" : "Convert into blocks"}
          </button>
          <button onClick={() => { setText(SAMPLE); setParsed(null); }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-parchment/20 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
            Load sample
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded-xl bg-red-500/15 text-red-300 px-4 py-3 text-[12px]" data-testid="studio-smart-paste-error">
          {err}
        </div>
      )}

      {parsed && (
        <div className="rounded-2xl border border-emerald-500/30 p-4"
             style={{ background: "rgba(8,32,24,0.5)" }}
             data-testid="studio-smart-paste-result">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 className="h-4 w-4 text-emerald-300" />
            <p className="font-display text-[15px] text-parchment">
              {parsed.chapters.length} chapter{parsed.chapters.length === 1 ? "" : "s"} detected
            </p>
          </div>
          <ul className="space-y-2 max-h-[280px] overflow-auto pr-1">
            {parsed.chapters.map((c, i) => (
              <li key={i} className="rounded-lg border border-parchment/10 bg-black/20 px-3 py-2">
                <p className="font-display text-[13.5px] text-parchment">{c.title}</p>
                <p className="text-[11px] text-faded">
                  {summariseBlocks(c.blocks)}
                </p>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => apply("append")}
                    data-testid="studio-smart-paste-append"
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink"
                    style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
              Append to editor
            </button>
            <button onClick={() => apply("replace")}
                    data-testid="studio-smart-paste-replace"
                    className="inline-flex items-center gap-1.5 rounded-full border border-parchment/25 bg-walnut/80 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
              Replace editor
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function summariseBlocks(blocks) {
  const counts = {};
  blocks.forEach((b) => { counts[b.type] = (counts[b.type] || 0) + 1; });
  return Object.entries(counts)
    .map(([t, n]) => `${n} ${t}${n === 1 ? "" : "s"}`)
    .join(" · ");
}
