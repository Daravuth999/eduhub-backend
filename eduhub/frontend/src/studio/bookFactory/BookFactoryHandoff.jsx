/**
 * BookFactoryHandoff.jsx — final review + safe, non-destructive handoff.
 *
 * Five explicit options (§HIGH 16): Keep current Editor draft · Replace with
 * generated draft · Download current Editor draft · Download generated JSON ·
 * Cancel. Preview uses the REAL Reader path (StudioPreview → ChapterBlocks).
 * Never silently overwrites an unsaved Editor draft, and never silently
 * exports an incomplete book — an incomplete draft requires explicit
 * confirmation. Generated payload enters the Editor dirty + unpublished
 * (parent seeds with _seedDirty; export forces published:false).
 */
import { useState } from "react";
import { ArrowRightCircle, ChevronDown, ChevronUp, Download, AlertTriangle, XCircle, FileDown } from "lucide-react";
import StudioPreview from "../StudioPreview";
import BookFactoryPublishFlow from "./BookFactoryPublishFlow";

export const BookFactoryHandoff = ({
  book, meta, editorDirty, jobId,
  coverEnabled, narrationEnabled, conversationAudioEnabled, directPublishEnabled,
  onOpenInEditor, onDownloadCurrentDraft, onCancel, onRefreshExport,
}) => {
  const [confirming, setConfirming] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  if (!book) return null;

  const incomplete = !!(meta && meta.incomplete);
  const needsConfirm = editorDirty || incomplete;

  const doOpen = () => {
    if (needsConfirm && !confirming) { setConfirming(true); return; }
    setConfirming(false);
    onOpenInEditor(book);
  };

  const downloadGenerated = () => {
    const blob = new Blob([JSON.stringify(book, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${book.title || "book"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-3" data-testid="book-factory-handoff">
      {incomplete && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-900/20 p-2.5 text-[12px] text-amber-200" data-testid="bf-incomplete-warning">
          {meta.completed} of {meta.total} chapters completed — continue with incomplete draft?
        </div>
      )}
      {/* Primary path: Save Draft / Publish / optional cover & narration —
          all server-authoritative, all reusing the existing studio save and
          publish routes under the hood. */}
      <BookFactoryPublishFlow
        jobId={jobId}
        coverEnabled={coverEnabled}
        narrationEnabled={narrationEnabled}
        conversationAudioEnabled={conversationAudioEnabled}
        directPublishEnabled={directPublishEnabled}
        onRefreshExport={onRefreshExport}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button data-testid="bf-replace-draft" onClick={doOpen}
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-bold uppercase tracking-wider text-ink"
                style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}>
          <ArrowRightCircle className="h-4 w-4" /> Open in Editor for advanced changes
        </button>
        {onCancel && (
          <button data-testid="bf-keep-current" onClick={onCancel}
                  className="inline-flex items-center gap-2 rounded-full border border-parchment/30 px-4 py-2 text-[12px] font-bold uppercase tracking-wider text-parchment">
            <XCircle className="h-4 w-4" /> Keep current Editor draft
          </button>
        )}
      </div>

      {confirming && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-900/20 p-3" data-testid="bf-dirty-confirm">
          <p className="text-[12px] text-amber-200 inline-flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            {editorDirty ? "Your current Editor draft has unsaved changes." : "This draft is incomplete."}
          </p>
          <p className="text-[11.5px] text-amber-100/80 mt-1">Opening this generated draft will replace what is currently in the Editor.</p>
          <div className="flex gap-2 mt-2">
            <button data-testid="bf-dirty-confirm-yes" onClick={doOpen} className="rounded-full bg-amber-500 px-3 py-1 text-[11px] font-bold text-ink">Replace draft</button>
            <button data-testid="bf-dirty-confirm-cancel" onClick={() => setConfirming(false)} className="rounded-full border border-parchment/30 px-3 py-1 text-[11px] text-parchment">Cancel</button>
          </div>
        </div>
      )}

      {/* Advanced / Backup — technical download-only actions, de-emphasized
          and collapsed by default per the "no technical download buttons as
          the primary experience" requirement. */}
      <div className="rounded-xl border border-parchment/10">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          data-testid="bf-advanced-toggle"
          className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-faded"
        >
          Advanced / Backup
          {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {showAdvanced && (
          <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
            {onDownloadCurrentDraft && (
              <button data-testid="bf-download-current" onClick={onDownloadCurrentDraft}
                      className="inline-flex items-center gap-2 rounded-full border border-gold/30 px-4 py-2 text-[12px] font-bold uppercase tracking-wider text-gold hover:bg-gold/10">
                <FileDown className="h-4 w-4" /> Download current draft
              </button>
            )}
            <button data-testid="bf-download-json" onClick={downloadGenerated}
                    className="inline-flex items-center gap-2 rounded-full border border-gold/30 px-4 py-2 text-[12px] font-bold uppercase tracking-wider text-gold hover:bg-gold/10">
              <Download className="h-4 w-4" /> Download generated JSON
            </button>
          </div>
        )}
      </div>

      <p className="text-[10.5px] text-faded">
        This draft is unpublished until you click Publish above. Saving persists it to your Studio Browse list;
        publishing is always a separate, explicit action.
      </p>

      <StudioPreview book={book} />
    </div>
  );
};

export default BookFactoryHandoff;
