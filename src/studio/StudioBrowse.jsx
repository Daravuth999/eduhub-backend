/**
 * StudioBrowse — list of books (MongoDB-authored + legacy sheet mirror).
 *
 * Shows every slug with latest revision, published state, and actions:
 *   edit · preview · publish / unpublish · delete.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Pencil, Eye, Trash2, CheckCircle2, EyeOff, Loader2 } from "lucide-react";
import { listStudioBooks, publishBook, unpublishBook, deleteBook, getStudioBook } from "./api";

export default function StudioBrowse({ onEdit, onPreview }) {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await listStudioBooks();
      setBooks(res.books || []);
    } catch (e) {
      setErr(e.message || "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleEdit = async (slug) => {
    setBusy(slug);
    try {
      const res = await getStudioBook(slug);
      onEdit?.(res.book);
    } finally { setBusy(null); }
  };
  const togglePub = async (slug, published) => {
    setBusy(slug);
    try {
      if (published) await unpublishBook(slug); else await publishBook(slug);
      await load();
    } finally { setBusy(null); }
  };
  const del = async (slug) => {
    if (!window.confirm(`Delete all revisions of "${slug}"? This cannot be undone.`)) return;
    setBusy(slug);
    try {
      await deleteBook(slug);
      await load();
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-3" data-testid="studio-browse">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-[17px] text-parchment">Your books</h3>
        <button onClick={load} disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-full border border-parchment/20 bg-walnut/80 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>
      {err && <div className="rounded-xl bg-red-500/15 text-red-300 px-4 py-3 text-[12px]">{err}</div>}
      {books.length === 0 && !loading && (
        <div className="rounded-2xl border border-dashed border-parchment/15 p-8 text-center text-faded text-[12px]"
             data-testid="studio-browse-empty">
          No books yet. Use the Editor, Smart paste, or Upload to create your first book.
        </div>
      )}
      <ul className="space-y-2">
        {books.map((b) => (
          <li key={b.slug} className="rounded-xl border border-parchment/10 p-3 flex items-center gap-3"
              style={{ background: "rgba(34,24,48,0.5)" }}
              data-testid={`studio-browse-item-${b.slug}`}>
            <div
              className="h-14 w-10 shrink-0 rounded-md grid place-items-center"
              style={{
                background: b.coverImage
                  ? `url(${b.coverImage}) center/cover`
                  : b.coverGradient,
                boxShadow: "0 6px 14px -6px rgba(0,0,0,0.7)",
              }}
            >
              {!b.coverImage && <span className="text-2xl">{b.coverEmoji}</span>}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-display text-[14px] text-parchment truncate">{b.title}</p>
              <p className="text-[11px] text-faded truncate">
                {b.section} · rev {b.revision || 0} · {b.chapters?.length || 0} chapters
              </p>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${b.published ? "text-emerald-300 bg-emerald-500/15" : "text-amber-300 bg-amber-500/15"}`}>
              {b.published ? "Live" : "Draft"}
            </span>
            <div className="flex items-center gap-1">
              <IconAction onClick={() => handleEdit(b.slug)} busy={busy === b.slug} icon={Pencil} title="Edit" testid={`studio-browse-edit-${b.slug}`} />
              <IconAction onClick={() => onPreview?.(b)} icon={Eye} title="Preview" testid={`studio-browse-preview-${b.slug}`} />
              <IconAction onClick={() => togglePub(b.slug, b.published)} busy={busy === b.slug}
                          icon={b.published ? EyeOff : CheckCircle2}
                          title={b.published ? "Unpublish" : "Publish"}
                          testid={`studio-browse-togglepub-${b.slug}`} />
              <IconAction onClick={() => del(b.slug)} busy={busy === b.slug} icon={Trash2}
                          title="Delete all revisions" danger testid={`studio-browse-delete-${b.slug}`} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IconAction({ onClick, icon: Icon, title, busy, danger, testid }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} title={title}
            data-testid={testid}
            className={`h-8 w-8 grid place-items-center rounded-full hover:bg-white/10 transition-colors ${danger ? "text-red-300 hover:text-red-200" : "text-parchment/80 hover:text-gold"}`}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
    </button>
  );
}
