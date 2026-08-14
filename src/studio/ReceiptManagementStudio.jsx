/**
 * ReceiptManagementStudio.jsx — Author Studio panel for the Persistent
 * Tuition Receipt Engine (Aug 2026).
 *
 * Search/filter (student, month, method, invoice number), preview,
 * download PDF/PNG, regenerate (file bytes only — never touches financial
 * fields on the receipt), and a one-shot invoice-number backfill for
 * receipts that predate this feature. Follows the same panel convention
 * as CouponStudio.jsx (load()/useCallback, stats row, error banner) and
 * uses tuitionAdminApi.js — the established /api/admin/tuition/* wrapper —
 * for every call except binary PDF/PNG downloads, which tuitionAdminApi's
 * request() can't serve (it always parses JSON), so those use getToken()/
 * url() directly with fetch().
 */
import { useCallback, useEffect, useState } from "react";
import {
  Receipt, RefreshCw, Search, Download, Eye, RotateCw, AlertTriangle, FileText,
} from "lucide-react";
import {
  searchTuitionReceipts, regenerateTuitionReceiptFile, backfillInvoiceNumbers,
  getToken, url,
} from "./tuitionAdminApi";

function fmtAmount(receipt) {
  const v = receipt.amount_usd;
  return typeof v === "number" ? `$${v.toFixed(2)}` : "—";
}

function fmtDate(raw) {
  if (!raw) return "—";
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return String(raw);
  }
}

async function fetchReceiptFile(receiptId, fmt) {
  const tok = getToken();
  const headers = tok ? { Authorization: `Bearer ${tok}` } : {};
  const res = await fetch(url(`/api/admin/tuition/receipt/${encodeURIComponent(receiptId)}/${fmt}`), {
    credentials: "include",
    headers,
  });
  if (!res.ok) throw new Error(`Failed to fetch ${fmt.toUpperCase()} (HTTP ${res.status})`);
  return res.blob();
}

function downloadBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

function ReceiptRow({ receipt, onRegenerate, regenerating }) {
  const [busy, setBusy] = useState(null); // "pdf" | "png" | "preview" | null
  const [rowErr, setRowErr] = useState(null);
  const displayNumber = receipt.invoice_number || receipt.receipt_id;

  const handleDownload = async (fmt) => {
    setBusy(fmt);
    setRowErr(null);
    try {
      const blob = await fetchReceiptFile(receipt.receipt_id, fmt);
      downloadBlob(blob, `${displayNumber}.${fmt}`);
    } catch (e) {
      setRowErr(e.message || `Failed to download ${fmt}`);
    } finally {
      setBusy(null);
    }
  };

  const handlePreview = async () => {
    setBusy("preview");
    setRowErr(null);
    try {
      const blob = await fetchReceiptFile(receipt.receipt_id, "pdf");
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      setRowErr(e.message || "Failed to preview receipt");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid="receipt-row"
      className="grid grid-cols-[1.2fr,1fr,0.8fr,0.9fr,1fr,auto] gap-3 items-center rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[12px]"
    >
      <div className="font-mono text-parchment truncate" title={displayNumber}>{displayNumber}</div>
      <div className="text-faded truncate" title={receipt.clean_id}>{receipt.clean_id || receipt.student_id || "—"}</div>
      <div className="text-parchment font-semibold">{fmtAmount(receipt)}</div>
      <div className="text-faded uppercase">{receipt.method || "—"}</div>
      <div className="text-faded">{fmtDate(receipt.confirmed_at)}</div>
      <div className="flex items-center gap-1.5 justify-end">
        <button
          onClick={handlePreview}
          disabled={busy !== null}
          title="Preview"
          className="p-1.5 rounded-lg border border-white/10 hover:border-gold/40 disabled:opacity-40"
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => handleDownload("pdf")}
          disabled={busy !== null}
          title="Download PDF"
          data-testid="receipt-download-pdf"
          className="p-1.5 rounded-lg border border-white/10 hover:border-gold/40 disabled:opacity-40"
        >
          <FileText className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => handleDownload("png")}
          disabled={busy !== null}
          title="Download PNG"
          data-testid="receipt-download-png"
          className="p-1.5 rounded-lg border border-white/10 hover:border-gold/40 disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onRegenerate(receipt.receipt_id)}
          disabled={busy !== null || regenerating === receipt.receipt_id}
          title="Regenerate file (financial data is never changed)"
          data-testid="receipt-regenerate"
          className="p-1.5 rounded-lg border border-white/10 hover:border-gold/40 disabled:opacity-40"
        >
          <RotateCw className={`h-3.5 w-3.5 ${regenerating === receipt.receipt_id ? "animate-spin" : ""}`} />
        </button>
      </div>
      {rowErr && (
        <div className="col-span-6 text-[11px] text-red-300">{rowErr}</div>
      )}
    </div>
  );
}

export default function ReceiptManagementStudio() {
  const [filters, setFilters] = useState({ student_id: "", month: "", method: "", invoice_number: "", q: "" });
  const [receipts, setReceipts] = useState([]);
  const [total, setTotal] = useState(0);
  const [unbackfilled, setUnbackfilled] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [regeneratingId, setRegeneratingId] = useState(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await searchTuitionReceipts(filters);
      setReceipts(res.receipts || []);
      setTotal(res.total || 0);
      setUnbackfilled(res.unbackfilled || 0);
    } catch (e) {
      setErr(e.message || "Failed to load receipts.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const handleRegenerate = async (receiptId) => {
    setRegeneratingId(receiptId);
    setErr(null);
    try {
      await regenerateTuitionReceiptFile(receiptId);
      await load();
    } catch (e) {
      setErr(e.message || "Failed to regenerate receipt file.");
    } finally {
      setRegeneratingId(null);
    }
  };

  const handleBackfill = async () => {
    setBackfilling(true);
    setBackfillMsg(null);
    try {
      const res = await backfillInvoiceNumbers();
      setBackfillMsg(`Assigned ${res.assigned} invoice number${res.assigned === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setBackfillMsg(e.message || "Backfill failed.");
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="receipt-management-studio">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-display text-[20px] text-parchment flex items-center gap-2">
            <Receipt className="h-5 w-5 text-gold" /> Receipt Management
          </h2>
          <p className="text-[12px] text-faded mt-0.5">
            Search, preview, and download tuition receipts. Regenerate re-renders the
            file only — historical financial values are never editable here.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          title="Refresh"
          className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] text-parchment hover:border-gold/40 transition disabled:opacity-40"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {unbackfilled > 0 && (
        <div
          data-testid="receipt-backfill-banner"
          className="flex items-center justify-between gap-3 rounded-xl border border-gold/25 bg-gold/[0.06] px-3 py-2.5"
        >
          <p className="text-[12px] text-parchment">
            {unbackfilled} receipt{unbackfilled === 1 ? "" : "s"} predate the invoice-numbering
            system and don&apos;t have an invoice number yet.
          </p>
          <button
            onClick={handleBackfill}
            disabled={backfilling}
            data-testid="receipt-backfill-btn"
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink transition disabled:opacity-50 flex-shrink-0"
            style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}
          >
            {backfilling ? "Assigning…" : "Backfill Invoice Numbers"}
          </button>
        </div>
      )}
      {backfillMsg && <p className="text-[11px] text-faded">{backfillMsg}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <input
          value={filters.student_id}
          onChange={(e) => setFilters((f) => ({ ...f, student_id: e.target.value }))}
          placeholder="Student ID"
          data-testid="receipt-filter-student"
          className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-parchment placeholder:text-faded"
        />
        <input
          type="month"
          value={filters.month}
          onChange={(e) => setFilters((f) => ({ ...f, month: e.target.value }))}
          data-testid="receipt-filter-month"
          className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-parchment"
        />
        <select
          value={filters.method}
          onChange={(e) => setFilters((f) => ({ ...f, method: e.target.value }))}
          data-testid="receipt-filter-method"
          className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-parchment"
        >
          <option value="">All methods</option>
          <option value="khqr">KHQR</option>
          <option value="cash">Cash</option>
          <option value="bank_transfer">Bank Transfer</option>
        </select>
        <input
          value={filters.invoice_number}
          onChange={(e) => setFilters((f) => ({ ...f, invoice_number: e.target.value }))}
          placeholder="Invoice #"
          data-testid="receipt-filter-invoice"
          className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-parchment placeholder:text-faded"
        />
        <div className="relative">
          <Search className="h-3.5 w-3.5 text-faded absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="Search reference…"
            data-testid="receipt-filter-q"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] pl-7 pr-2.5 py-1.5 text-[12px] text-parchment placeholder:text-faded"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center">
          <p className="font-display text-[22px] font-bold text-parchment">{total}</p>
          <p className="text-[10px] uppercase tracking-wider text-faded">Matching Receipts</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center">
          <p className="font-display text-[22px] font-bold text-faded">{unbackfilled}</p>
          <p className="text-[10px] uppercase tracking-wider text-faded">Missing Invoice #</p>
        </div>
      </div>

      {err && (
        <div className="flex items-center gap-2 rounded-lg border border-red-400/25 bg-red-900/20 px-3 py-2 text-[12px] text-red-300">
          <AlertTriangle className="h-3.5 w-3.5 flex-none" /> {err}
        </div>
      )}

      {loading && (
        <div className="text-center py-10 text-faded text-[12px]">Loading receipts…</div>
      )}

      {!loading && receipts.length === 0 && (
        <div className="text-center py-12 rounded-2xl border border-dashed border-white/15" data-testid="receipt-empty">
          <Receipt className="h-8 w-8 text-faded mx-auto mb-3" />
          <p className="text-[13px] text-faded">No receipts match these filters.</p>
        </div>
      )}

      {!loading && receipts.length > 0 && (
        <div className="space-y-2">
          {receipts.map((r) => (
            <ReceiptRow
              key={r.receipt_id}
              receipt={r}
              onRegenerate={handleRegenerate}
              regenerating={regeneratingId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
