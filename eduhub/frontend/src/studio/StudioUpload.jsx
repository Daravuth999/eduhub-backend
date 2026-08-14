/**
 * StudioUpload — drag-drop or pick a .docx / .txt / .md file and get
 * structured chapters back. Uses the same parser as Smart paste.
 */
import { useRef, useState } from "react";
import { Upload, Loader2, FileText, CheckCircle2 } from "lucide-react";
import { uploadDoc } from "./api";

export default function StudioUpload({ onApply }) {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  const run = async () => {
    if (!file) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await uploadDoc(file);
      setParsed(res);
    } catch (e) {
      setErr(e.message || "Upload failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="studio-upload">
      <div className="rounded-2xl border border-dashed border-gold/30 p-6 text-center"
           style={{ background: "rgba(34,24,48,0.55)" }}
           onClick={() => inputRef.current?.click()}
           onDragOver={(e) => e.preventDefault()}
           onDrop={(e) => {
             e.preventDefault();
             const f = e.dataTransfer.files?.[0];
             if (f) { setFile(f); setParsed(null); }
           }}>
        <Upload className="mx-auto h-8 w-8 text-gold/70" />
        <p className="mt-2 font-display text-[15px] text-parchment">
          Drop a <span className="text-gold">.docx / .txt / .md</span> here
        </p>
        <p className="text-[11px] text-faded">Or click to pick a file</p>
        <input ref={inputRef} type="file" accept=".docx,.txt,.md,.markdown"
               className="hidden"
               data-testid="studio-upload-input"
               onChange={(e) => {
                 const f = e.target.files?.[0];
                 if (f) { setFile(f); setParsed(null); }
               }} />
        {file && (
          <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-parchment/15 bg-black/30 px-3 py-1.5 text-[12px] text-parchment">
            <FileText className="h-3.5 w-3.5 text-gold" /> {file.name}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={run} disabled={!file || loading}
                data-testid="studio-upload-parse"
                className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink disabled:opacity-60"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {loading ? "Parsing" : "Parse file"}
        </button>
      </div>

      {err && (
        <div className="rounded-xl bg-red-500/15 text-red-300 px-4 py-3 text-[12px]" data-testid="studio-upload-error">
          {err}
        </div>
      )}

      {parsed && (
        <div className="rounded-2xl border border-emerald-500/30 p-4"
             style={{ background: "rgba(8,32,24,0.5)" }}
             data-testid="studio-upload-result">
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
                <p className="text-[11px] text-faded">{c.blocks.length} blocks</p>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => { onApply?.({ chapters: parsed.chapters, mode: "append" }); setParsed(null); setFile(null); }}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink"
                    style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
              Append to editor
            </button>
            <button onClick={() => { onApply?.({ chapters: parsed.chapters, mode: "replace" }); setParsed(null); setFile(null); }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-parchment/25 bg-walnut/80 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
              Replace editor
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
