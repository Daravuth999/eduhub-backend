/**
 * PaymentStudio.jsx — ABA PayWay Smart Payment Bridge
 * Author Studio tab v1.0
 *
 * Sections:
 *   A) Dashboard stats (today / pending / review / completed)
 *   B) Transaction list with review queue
 *   C) Points conversion packages (admin configurable)
 *   D) Manual paste fallback (parse a Telegram notification)
 *
 * PROTECTED: Does NOT touch any existing module. Pure additive new file.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  LayoutDashboard, Clock, CheckCircle2, XCircle, AlertTriangle,
  ChevronDown, ChevronUp, RefreshCw, Plus, Trash2, Edit3,
  Clipboard, Send, Coins, Receipt, User, Filter, X, Save,
  Info, Zap, QrCode, ToggleLeft, ToggleRight, ShieldCheck,
} from "lucide-react";

const BACKEND = process.env.REACT_APP_BACKEND_URL || "";
const TOKEN_KEY = "studio_session_token_v1";
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };

async function apiFetch(path, opts = {}) {
  const fullPath = `/api${path}`;
  const url = BACKEND ? `${BACKEND.replace(/\/$/, "")}${fullPath}` : fullPath;
  const tok = getToken();
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  const r = await fetch(url, { credentials: "include", headers, ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
  return data;
}

// ── Status badge ──────────────────────────────────────────────────────────

const STATUS_META = {
  received:        { label: "Received",       color: "#60a5fa", bg: "rgba(96,165,250,0.12)" },
  auto_processing: { label: "Processing…",    color: "#fbbf24", bg: "rgba(251,191,36,0.12)" },
  needs_review:    { label: "Needs Review",   color: "#f97316", bg: "rgba(249,115,22,0.15)" },
  completed:       { label: "Completed",      color: "#4ade80", bg: "rgba(74,222,128,0.12)" },
  rejected:        { label: "Rejected",       color: "#f87171", bg: "rgba(248,113,113,0.12)" },
  unmatched:       { label: "Unmatched",      color: "#a78bfa", bg: "rgba(167,139,250,0.12)" },
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, color: "#9ca3af", bg: "rgba(156,163,175,0.12)" };
  return (
    <span
      style={{
        background: meta.bg,
        color: meta.color,
        border: `1px solid ${meta.color}40`,
        borderRadius: 6,
        padding: "2px 8px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────

function StatCard({ label, value, color, icon: Icon }) {
  return (
    <div
      style={{
        background: "rgba(45,31,62,0.65)",
        border: `1px solid ${color}30`,
        borderRadius: 14,
        padding: "16px 20px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        flex: "1 1 140px",
      }}
    >
      <div
        style={{
          width: 40, height: 40,
          borderRadius: 10,
          background: `${color}18`,
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon size={18} color={color} />
      </div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      </div>
    </div>
  );
}

// ── Transaction row ───────────────────────────────────────────────────────

function TxnRow({ txn, onApprove, onReject, refreshing }) {
  const [open, setOpen] = useState(false);
  const [studentId, setStudentId] = useState(txn.matched_student_id || "");
  const [intentType, setIntentType] = useState(txn.matched_intent_type || "points");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const needsAction = ["needs_review", "unmatched", "received"].includes(txn.status);
  const isCompleted = txn.status === "completed";

  async function handleApprove() {
    if (!studentId.trim()) { setErr("Student ID required"); return; }
    setLoading(true); setErr("");
    try {
      await onApprove(txn._id, { student_id: studentId, intent_type: intentType, note });
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }

  async function handleReject() {
    setLoading(true); setErr("");
    try { await onReject(txn._id, { reason: note || "Rejected by admin" }); }
    catch (e) { setErr(e.message); }
    setLoading(false);
  }

  return (
    <div
      style={{
        background: "rgba(20,14,32,0.55)",
        border: `1px solid ${needsAction ? "rgba(249,115,22,0.35)" : "rgba(255,255,255,0.07)"}`,
        borderRadius: 12,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      {/* Summary row */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "12px 16px", cursor: "pointer",
          flexWrap: "wrap",
        }}
      >
        <StatusBadge status={txn.status} />
        <span style={{ fontWeight: 700, color: "#FFE19A", fontSize: 15, minWidth: 70 }}>
          {txn.currency === "KHR" ? `${txn.amount?.toLocaleString()}៛` : `$${txn.amount?.toFixed(2)}`}
        </span>
        <span style={{ color: "#c4b5fd", fontSize: 13, flex: 1, minWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {txn.payer_name || "—"}
        </span>
        <span style={{ color: "#6b7280", fontSize: 11 }}>
          {txn.paid_at_raw || txn.created_at?.slice(0, 16)}
        </span>
        {txn.match_confidence && (
          <span style={{
            fontSize: 10, fontWeight: 700, textTransform: "uppercase",
            color: txn.match_confidence === "high" ? "#4ade80" : txn.match_confidence === "medium" ? "#fbbf24" : "#f87171",
            background: "rgba(0,0,0,0.3)", borderRadius: 4, padding: "2px 6px",
          }}>
            {txn.match_confidence} {txn.match_score != null ? `(${txn.match_score})` : ""}
          </span>
        )}
        {open ? <ChevronUp size={14} color="#6b7280" /> : <ChevronDown size={14} color="#6b7280" />}
      </div>

      {/* Expanded detail */}
      {open && (
        <div style={{ padding: "0 16px 16px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12, fontSize: 12 }}>
            {[
              ["Trx. ID", txn.transaction_id],
              ["APV", txn.apv],
              ["Method", txn.payment_method],
              ["Merchant", txn.merchant],
              ["Payer Acct", txn.payer_account || "—"],
              ["Matched Student", txn.matched_student_id || "—"],
              ["Match Reason", txn.match_reason || "—"],
            ].map(([k, v]) => (
              <div key={k}>
                <span style={{ color: "#6b7280" }}>{k}: </span>
                <span style={{ color: "#e5e7eb", wordBreak: "break-all" }}>{v}</span>
              </div>
            ))}
          </div>

          {/* Manual approval form */}
          {needsAction && (
            <div style={{ marginTop: 14, padding: 12, background: "rgba(45,31,62,0.5)", borderRadius: 10, border: "1px solid rgba(167,139,250,0.2)" }}>
              <div style={{ fontSize: 11, color: "#a78bfa", fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>
                Manual Assignment
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  placeholder="Student ID (e.g. stu094)"
                  value={studentId}
                  onChange={e => setStudentId(e.target.value)}
                  style={{ flex: "1 1 120px", background: "rgba(20,14,32,0.7)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "6px 10px", color: "#fff", fontSize: 12 }}
                />
                <select
                  value={intentType}
                  onChange={e => setIntentType(e.target.value)}
                  style={{ background: "rgba(20,14,32,0.7)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "6px 10px", color: "#fff", fontSize: 12 }}
                >
                  <option value="tuition">Tuition</option>
                  <option value="points">Points Purchase</option>
                </select>
                <input
                  placeholder="Admin note (optional)"
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  style={{ flex: "2 1 160px", background: "rgba(20,14,32,0.7)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "6px 10px", color: "#fff", fontSize: 12 }}
                />
              </div>
              {err && <div style={{ color: "#f87171", fontSize: 11, marginTop: 6 }}>{err}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  onClick={handleApprove}
                  disabled={loading}
                  style={{
                    background: "linear-gradient(135deg,#4ade80,#16a34a)", color: "#052e16",
                    border: "none", borderRadius: 8, padding: "7px 16px",
                    fontWeight: 700, fontSize: 12, cursor: loading ? "not-allowed" : "pointer",
                    opacity: loading ? 0.6 : 1,
                  }}
                >
                  <CheckCircle2 size={12} style={{ marginRight: 4 }} />
                  Approve & Complete
                </button>
                <button
                  onClick={handleReject}
                  disabled={loading}
                  style={{
                    background: "rgba(248,113,113,0.15)", color: "#f87171",
                    border: "1px solid rgba(248,113,113,0.3)", borderRadius: 8,
                    padding: "7px 16px", fontWeight: 700, fontSize: 12,
                    cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1,
                  }}
                >
                  <XCircle size={12} style={{ marginRight: 4 }} />
                  Reject
                </button>
              </div>
            </div>
          )}

          {isCompleted && txn.completion_result && (
            <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(74,222,128,0.08)", borderRadius: 8, border: "1px solid rgba(74,222,128,0.2)", fontSize: 12, color: "#4ade80" }}>
              ✅ {txn.manually_approved ? `Manually approved by ${txn.approved_by}` : "Auto-completed"}
              {txn.completion_result?.points_credited ? ` · +${txn.completion_result.points_credited} pts credited` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Points package editor ─────────────────────────────────────────────────

// v4 (USD packages): admin enters USD with 2 decimals. The shared fixed
// rate (4000 KHR per 1 USD) mirrors the backend default and is ONLY used
// here as a fallback to render legacy KHR-only packages — the source of
// truth for new packages is amount_usd.
const V4_KHR_PER_USD = 4000;
function v4PkgUsd(pkg) {
  // amount_usd is the v4 primary; fall back to KHR/rate for legacy docs.
  const usd = Number(pkg?.amount_usd);
  if (Number.isFinite(usd) && usd > 0) return usd;
  const khr = Number(pkg?.amount_khr);
  if (Number.isFinite(khr) && khr > 0) return Math.round((khr / V4_KHR_PER_USD) * 100) / 100;
  return 0;
}
function v4FmtUsd(n) {
  const v = Number(n) || 0;
  return `$${v.toFixed(2)}`;
}

function PackageRow({ pkg, onDelete, onSave }) {
  const [editing, setEditing] = useState(false);
  // v4: ensure amount_usd is present in the editor state — derive from KHR
  // if the package was authored before v4. amount_khr is hidden from the
  // editor UI but kept on the doc so the ABA / manual matching path
  // continues to find legacy packages.
  const _pkgUsdInit = v4PkgUsd(pkg);
  const [form, setForm] = useState({
    discount_active: false,
    discount_pct: 0,
    ...pkg,
    amount_usd: _pkgUsdInit > 0 ? _pkgUsdInit : (pkg?.amount_usd ?? ""),
  });
  const [loading, setLoading] = useState(false);

  async function handleSave() {
    setLoading(true);
    try {
      // v4: ship amount_usd as the primary edit; the backend cross-derives
      // amount_khr from the active rate so legacy ABA matching keeps working.
      const out = { ...form };
      if (out.amount_usd !== undefined && out.amount_usd !== "") {
        out.amount_usd = Number(out.amount_usd);
      }
      await onSave(pkg._id, out);
      setEditing(false);
    } catch (e) { alert(e.message); }
    setLoading(false);
  }

  const Field = ({ field, label, type = "text", step }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <label style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</label>
      <input
        type={type}
        step={step}
        value={form[field] ?? ""}
        onChange={e => setForm(f => ({ ...f, [field]: type === "number" ? Number(e.target.value) : e.target.value }))}
        style={{ background: "rgba(20,14,32,0.7)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 7, padding: "5px 8px", color: "#fff", fontSize: 12, width: "100%" }}
      />
    </div>
  );

  return (
    <div style={{ background: "rgba(20,14,32,0.55)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "12px 14px", marginBottom: 8 }}>
      {!editing ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
            background: pkg.active ? "#4ade80" : "#6b7280",
          }} />
          <span style={{ fontWeight: 700, color: "#FFE19A", fontSize: 14 }}>{pkg.label}</span>
          <span data-testid={`pkg-amount-usd-${pkg._id}`} style={{ color: "#c4b5fd", fontSize: 13 }}>{v4FmtUsd(v4PkgUsd(pkg))}</span>
          <span style={{ color: "#60a5fa", fontSize: 13 }}>→ {pkg.points} pts{pkg.bonus_points ? ` +${pkg.bonus_points} bonus` : ""}</span>
          {pkg.discount_active && pkg.discount_pct > 0 && (
            <span style={{ background: "linear-gradient(135deg,#f97316,#ef4444)", color: "#fff", fontSize: 10, fontWeight: 800, borderRadius: 6, padding: "2px 7px", marginLeft: 4 }}>
              {pkg.discount_label || pkg.discount_pct + "% OFF"}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={() => setEditing(true)}
            style={{ background: "rgba(96,165,250,0.15)", color: "#60a5fa", border: "1px solid rgba(96,165,250,0.25)", borderRadius: 7, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>
            <Edit3 size={10} style={{ marginRight: 4 }} />Edit
          </button>
          <button onClick={() => onDelete(pkg._id)}
            style={{ background: "rgba(248,113,113,0.12)", color: "#f87171", border: "1px solid rgba(248,113,113,0.2)", borderRadius: 7, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>
            <Trash2 size={10} style={{ marginRight: 4 }} />Remove
          </button>
        </div>
      ) : (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))", gap: 8, marginBottom: 10 }}>
            <Field field="label" label="Label" />
            <Field field="amount_usd" label="USD Amount ($)" type="number" step="0.01" />
            <Field field="points" label="Points" type="number" />
            <Field field="bonus_points" label="Bonus Pts" type="number" />
            <Field field="min_purchase" label="Min Purchase ($)" type="number" step="0.01" />
            <Field field="notes" label="Notes" />
          </div>
            <Field field="payment_link" label="ABA Payment Link" />
            <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 700, marginTop: 8, marginBottom: 4 }}>Discount Settings</div>
            <Field field="discount_pct" label="Discount %" type="number" />
            <Field field="discount_label" label="Badge Label e.g. Flash Sale" />
            <Field field="discount_expires_at" label="Expires At ISO datetime" />
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, cursor: "pointer" }}>
              <input type="checkbox" checked={!!form.discount_active}
                onChange={e => setForm(f => ({ ...f, discount_active: e.target.checked }))} />
              <span style={{ fontSize: 12, color: "#fbbf24" }}>Discount Active</span>
            </label>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "#e5e7eb" }}>
              <input type="checkbox" checked={form.active ?? true}
                onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} />
              Active
            </label>
            <button onClick={handleSave} disabled={loading}
              style={{ background: "linear-gradient(135deg,#4ade80,#16a34a)", color: "#052e16", border: "none", borderRadius: 8, padding: "6px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
              <Save size={11} style={{ marginRight: 4 }} />Save
            </button>
            <button onClick={() => setEditing(false)}
              style={{ background: "rgba(255,255,255,0.06)", color: "#9ca3af", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "6px 14px", fontSize: 12, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

// ── Method row (v1.6 Payment Methods Display) ────────────────────────────
// Renders one toggleable payment-method card in the Author Studio.
// Pure presentation; no payment logic.

function MethodRow({ methodKey, title, subtitle, Icon, meta, saving, onToggle }) {
  const enabled = !!(meta && meta.enabled);
  const configured = !!(meta && meta.configured);
  const providerReady = meta && meta.provider_ready;
  const reason = (meta && meta.reason) || "ok";
  // Visibility = enabled AND (for KHQR) provider_ready
  const studentVisible = enabled && (methodKey !== "khqr" || providerReady);
  const accent = studentVisible ? "#4ade80" : (enabled ? "#fbbf24" : "#6b7280");
  return (
    <div
      data-testid={`payment-method-row-${methodKey}`}
      style={{
        background: "rgba(20,14,32,0.55)",
        border: `1px solid ${accent}40`,
        borderRadius: 14,
        padding: "16px 18px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
      }}
    >
      <div style={{
        width: 44, height: 44, borderRadius: 11,
        background: `${accent}18`,
        border: `1px solid ${accent}45`,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0,
      }}>
        <Icon size={20} color={accent} />
      </div>
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#F4E5C1" }}>{title}</div>
          <span
            data-testid={`payment-method-status-${methodKey}`}
            style={{
              fontSize: 10, fontWeight: 800, letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: studentVisible ? "#bbf7d0" : "#fde68a",
              background: studentVisible ? "rgba(74,222,128,0.14)" : "rgba(251,191,36,0.14)",
              border: `1px solid ${studentVisible ? "rgba(74,222,128,0.4)" : "rgba(251,191,36,0.4)"}`,
              borderRadius: 999, padding: "2px 9px",
            }}
          >
            {studentVisible ? "Visible to students" : (enabled ? "Hidden — not ready" : "Disabled")}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: "#9ca3af", marginTop: 3 }}>{subtitle}</div>
        <div style={{ marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11 }}>
          <Diag label="Toggle" ok={enabled} text={enabled ? "ON" : "OFF"} />
          <Diag
            label="Configured"
            ok={configured}
            text={configured ? "Ready" : "Unavailable"}
          />
          {methodKey === "khqr" && (
            <Diag
              label="Provider"
              ok={!!providerReady}
              text={providerReady ? "Ready" : (reason || "not ready")}
            />
          )}
        </div>
      </div>
      <button
        onClick={onToggle}
        disabled={saving}
        data-testid={`payment-method-toggle-${methodKey}`}
        style={{
          background: enabled ? "linear-gradient(135deg,#4ade80,#16a34a)" : "rgba(75,85,99,0.35)",
          color: enabled ? "#052e16" : "#e5e7eb",
          border: enabled ? "1px solid rgba(74,222,128,0.6)" : "1px solid rgba(255,255,255,0.12)",
          borderRadius: 999,
          padding: "8px 16px",
          fontWeight: 800, fontSize: 12,
          cursor: saving ? "wait" : "pointer",
          minWidth: 110,
          display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
        }}
      >
        {enabled ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
        {enabled ? "ENABLED" : "DISABLED"}
      </button>
    </div>
  );
}

function Diag({ label, ok, text }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      color: ok ? "#86efac" : "#fca5a5",
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: ok ? "#4ade80" : "#f87171",
        display: "inline-block",
      }} />
      <span style={{ color: "#9ca3af" }}>{label}:</span>
      <span style={{ fontWeight: 700 }}>{text}</span>
    </span>
  );
}

export default function PaymentStudio() {
  const [section, setSection] = useState("dashboard");
  const [dashboard, setDashboard] = useState(null);
  const [txns, setTxns] = useState([]);
  const [txnFilter, setTxnFilter] = useState(""); // status filter
  const [packages, setPackages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [manualMsg, setManualMsg] = useState("");
  const [manualResult, setManualResult] = useState(null);
  const [manualLoading, setManualLoading] = useState(false);
  // v4 (USD packages): admin authors USD price. Backend cross-derives KHR
  // for legacy matching, so we don't ask the admin for KHR anymore.
  const [newPkg, setNewPkg] = useState({ label: "", amount_usd: "", points: "", bonus_points: 0, active: true, notes: "", payment_link: "", discount_pct: 0, discount_label: "", discount_active: false, discount_expires_at: "" });
  const [addingPkg, setAddingPkg] = useState(false);
  // v1.6 Payment Methods Display admin state
  const [methods, setMethods] = useState(null);   // { aba: {...}, khqr: {...} } | null
  const [methodsLoading, setMethodsLoading] = useState(false);
  const [methodsSaving, setMethodsSaving] = useState(false);
  const refreshTimer = useRef(null);

  const loadDashboard = useCallback(async () => {
    try {
      const d = await apiFetch("/payments/dashboard");
      setDashboard(d);
    } catch (e) { setErr(e.message); }
  }, []);

  const loadTxns = useCallback(async (status = "") => {
    setLoading(true);
    try {
      const d = await apiFetch(`/payments/transactions${status ? `?status=${status}&limit=80` : "?limit=80"}`);
      setTxns(d.transactions || []);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, []);

  const loadPackages = useCallback(async () => {
    try {
      const d = await apiFetch("/payments/settings/points-packages");
      setPackages(d.packages || []);
    } catch (e) { setErr(e.message); }
  }, []);

  // v1.6 — load payment-methods display config (admin diagnostic view)
  const loadMethods = useCallback(async () => {
    setMethodsLoading(true);
    try {
      const d = await apiFetch("/admin/payments/methods");
      setMethods(d || null);
    } catch (e) { setErr(e.message); }
    setMethodsLoading(false);
  }, []);

  // v1.6 — patch a method toggle
  const patchMethod = useCallback(async (method, enabled) => {
    setMethodsSaving(true);
    try {
      const d = await apiFetch("/admin/payments/methods", {
        method: "PATCH",
        body: JSON.stringify({ [method]: { enabled: !!enabled } }),
      });
      setMethods(d || null);
    } catch (e) { setErr(e.message); }
    setMethodsSaving(false);
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (section === "transactions") loadTxns(txnFilter);
    if (section === "packages") loadPackages();
    if (section === "methods") loadMethods();
  }, [section, txnFilter, loadTxns, loadPackages, loadMethods]);

  // Auto-refresh every 30 s when on dashboard or transactions
  useEffect(() => {
    if (section === "dashboard" || section === "transactions") {
      refreshTimer.current = setInterval(() => {
        if (section === "dashboard") loadDashboard();
        else loadTxns(txnFilter);
      }, 30_000);
    }
    return () => clearInterval(refreshTimer.current);
  }, [section, txnFilter, loadDashboard, loadTxns]);

  async function handleApprove(txnId, payload) {
    await apiFetch(`/payments/transactions/${txnId}/approve`, {
      method: "POST", body: JSON.stringify(payload),
    });
    await loadTxns(txnFilter);
    await loadDashboard();
  }

  async function handleReject(txnId, payload) {
    await apiFetch(`/payments/transactions/${txnId}/reject`, {
      method: "POST", body: JSON.stringify(payload),
    });
    await loadTxns(txnFilter);
    await loadDashboard();
  }

  async function handleManualParse() {
    if (!manualMsg.trim()) return;
    setManualLoading(true); setManualResult(null);
    try {
      const d = await apiFetch("/payments/parse-manual", {
        method: "POST", body: JSON.stringify({ message: manualMsg }),
      });
      setManualResult(d);
      await loadDashboard();
    } catch (e) { setManualResult({ error: e.message }); }
    setManualLoading(false);
  }

  async function handleDeletePkg(pkgId) {
    if (!window.confirm("Delete this package?")) return;
    await apiFetch(`/payments/settings/points-packages/${pkgId}`, { method: "DELETE" });
    await loadPackages();
  }

  async function handleSavePkg(pkgId, form) {
    await apiFetch(`/payments/settings/points-packages/${pkgId}`, {
      method: "PATCH", body: JSON.stringify(form),
    });
    await loadPackages();
  }

  async function handleAddPkg() {
    if (!newPkg.label || !newPkg.amount_usd || !newPkg.points) {
      alert("Label, USD Amount, and Points are required"); return;
    }
    setAddingPkg(true);
    try {
      await apiFetch("/payments/settings/points-packages", {
        method: "POST",
        body: JSON.stringify({
          ...newPkg,
          amount_usd:   Number(newPkg.amount_usd),
          points:       Number(newPkg.points),
          bonus_points: Number(newPkg.bonus_points || 0),
        }),
      });
      setNewPkg({ label: "", amount_usd: "", points: "", bonus_points: 0, active: true, notes: "", payment_link: "", discount_pct: 0, discount_label: "", discount_active: false, discount_expires_at: "" });
      await loadPackages();
    } catch (e) { alert(e.message); }
    setAddingPkg(false);
  }

  const stats = dashboard?.stats || {};

  // ── Styles ──
  const S = {
    nav: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 20 },
    navBtn: (active) => ({
      padding: "6px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700,
      textTransform: "uppercase", letterSpacing: "0.05em", cursor: "pointer", border: "none",
      background: active ? "linear-gradient(135deg,#FFE19A,#D4A843)" : "rgba(45,31,62,0.65)",
      color: active ? "#1a1420" : "#F4E5C1",
      boxShadow: active ? "0 4px 10px rgba(212,168,67,0.3)" : "none",
    }),
    section: { animation: "fadeIn 0.2s ease" },
    heading: { fontSize: 14, fontWeight: 700, color: "#c4b5fd", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12 },
    card: { background: "rgba(20,14,32,0.55)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: 16, marginBottom: 12 },
  };

  const NAVS = [
    { key: "dashboard",    label: "Dashboard",     Icon: LayoutDashboard },
    { key: "transactions", label: "Transactions",  Icon: Receipt },
    { key: "packages",     label: "Points Packages", Icon: Coins },
    { key: "methods",      label: "Methods Display", Icon: QrCode },
    { key: "manual",       label: "Manual Paste",  Icon: Clipboard },
  ];

  return (
    <div style={{ color: "#F4E5C1", fontFamily: "inherit" }}>
      {/* Sub-nav */}
      <nav style={S.nav}>
        {NAVS.map(({ key, label, Icon }) => (
          <button key={key} onClick={() => setSection(key)} style={S.navBtn(section === key)}>
            <Icon size={11} style={{ marginRight: 5, verticalAlign: "middle" }} />
            {label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => {
            loadDashboard();
            if (section === "transactions") loadTxns(txnFilter);
            if (section === "packages") loadPackages();
            if (section === "methods") loadMethods();
          }}
          style={{ background: "rgba(96,165,250,0.12)", color: "#60a5fa", border: "1px solid rgba(96,165,250,0.2)", borderRadius: 20, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>
          <RefreshCw size={11} style={{ marginRight: 4 }} />Refresh
        </button>
      </nav>

      {err && (
        <div style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 10, padding: "10px 14px", marginBottom: 12, color: "#f87171", fontSize: 12, display: "flex", justifyContent: "space-between" }}>
          {err}
          <button onClick={() => setErr("")} style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer" }}><X size={12} /></button>
        </div>
      )}

      {/* ── A) Dashboard ─────────────────────────────────────────────── */}
      {section === "dashboard" && (
        <div style={S.section}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
            <StatCard label="Today" value={stats.total_today ?? "—"} color="#60a5fa" icon={LayoutDashboard} />
            <StatCard label="Pending" value={stats.pending ?? "—"} color="#fbbf24" icon={Clock} />
            <StatCard label="Needs Review" value={stats.needs_review ?? "—"} color="#f97316" icon={AlertTriangle} />
            <StatCard label="Completed" value={stats.completed ?? "—"} color="#4ade80" icon={CheckCircle2} />
            <StatCard label="Rejected" value={stats.rejected ?? "—"} color="#f87171" icon={XCircle} />
            <StatCard label="Unmatched" value={stats.unmatched ?? "—"} color="#a78bfa" icon={Zap} />
          </div>

          {stats.needs_review > 0 && (
            <div style={{ background: "rgba(249,115,22,0.1)", border: "1px solid rgba(249,115,22,0.3)", borderRadius: 12, padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
              <AlertTriangle size={16} color="#f97316" />
              <span style={{ color: "#fdba74", fontWeight: 600, fontSize: 13 }}>
                {stats.needs_review} transaction{stats.needs_review !== 1 ? "s" : ""} need manual review
              </span>
              <button
                onClick={() => { setTxnFilter("needs_review"); setSection("transactions"); }}
                style={{ marginLeft: "auto", background: "#f97316", color: "#fff", border: "none", borderRadius: 8, padding: "5px 12px", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>
                Review Now
              </button>
            </div>
          )}

          <div style={S.heading}>Recent Transactions</div>
          {(dashboard?.recent_transactions || []).map(txn => (
            <TxnRow key={txn._id} txn={txn} onApprove={handleApprove} onReject={handleReject} />
          ))}
          {!dashboard && <div style={{ color: "#6b7280", fontSize: 13 }}>Loading…</div>}
        </div>
      )}

      {/* ── B) Transactions ───────────────────────────────────────────── */}
      {section === "transactions" && (
        <div style={S.section}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <div style={S.heading}>All Transactions</div>
            <div style={{ flex: 1 }} />
            <Filter size={12} color="#9ca3af" />
            <select
              value={txnFilter}
              onChange={e => setTxnFilter(e.target.value)}
              style={{ background: "rgba(20,14,32,0.7)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "5px 10px", color: "#fff", fontSize: 12 }}
            >
              <option value="">All</option>
              <option value="needs_review">Needs Review</option>
              <option value="unmatched">Unmatched</option>
              <option value="completed">Completed</option>
              <option value="rejected">Rejected</option>
              <option value="received">Received</option>
            </select>
          </div>
          {loading && <div style={{ color: "#6b7280", fontSize: 13 }}>Loading…</div>}
          {txns.map(txn => (
            <TxnRow key={txn._id} txn={txn} onApprove={handleApprove} onReject={handleReject} />
          ))}
          {!loading && txns.length === 0 && (
            <div style={{ color: "#6b7280", fontSize: 13, textAlign: "center", padding: 30 }}>No transactions found.</div>
          )}
        </div>
      )}

      {/* ── C) Points packages ───────────────────────────────────────── */}
      {section === "packages" && (
        <div style={S.section}>
          <div style={S.heading}>Points Conversion Packages</div>
          <div style={{ ...S.card, borderColor: "rgba(96,165,250,0.2)", marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "#93c5fd", lineHeight: 1.6 }}>
              <Info size={11} style={{ marginRight: 4 }} />
              Configure how much USD converts to how many EduHub points.
              When a payment is auto-matched as a points purchase, the closest active package is used.
              The conversion rate is fully controlled here — no hardcoding.
              <span style={{ display: "block", marginTop: 6, color: "#a78bfa", fontSize: 11 }}>
                Legacy KHR-priced packages are auto-converted at 4000 KHR / $1 for display; admin saves keep both fields in sync server-side.
              </span>
            </div>
          </div>

          {packages.map(pkg => (
            <PackageRow key={pkg._id} pkg={pkg} onDelete={handleDeletePkg} onSave={handleSavePkg} />
          ))}

          {/* Add new package */}
          <div style={{ ...S.card, borderColor: "rgba(74,222,128,0.2)", marginTop: 16 }}>
            <div style={S.heading}>Add New Package</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(130px,1fr))", gap: 8, marginBottom: 10 }}>
              {[
                ["label", "Label", "text", "e.g. $1.25 Pack", undefined],
                ["amount_usd", "USD Amount ($)", "number", "1.25", "0.01"],
                ["points", "Points", "number", "105", undefined],
                ["bonus_points", "Bonus Pts", "number", "0", undefined],
                ["payment_link", "ABA Payment Link", "text", "https://link.payway.com.kh/...", undefined],
                ["notes", "Notes", "text", "", undefined],
                ["discount_pct", "Discount %", "number", "0", undefined],
                ["discount_label", "Badge Label", "text", "e.g. Flash Sale", undefined],
                ["discount_expires_at", "Expires At", "text", "2026-12-31T23:59:59", undefined],
              ].map(([field, label, type, placeholder, step]) => (
                <div key={field} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <label style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</label>
                  <input
                    type={type} placeholder={placeholder} step={step} value={newPkg[field] ?? ""}
                    onChange={e => setNewPkg(p => ({ ...p, [field]: type === "number" ? e.target.value : e.target.value }))}
                    style={{ background: "rgba(20,14,32,0.7)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 7, padding: "5px 8px", color: "#fff", fontSize: 12 }}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "#e5e7eb" }}>
                <input type="checkbox" checked={newPkg.active ?? true}
                  onChange={e => setNewPkg(p => ({ ...p, active: e.target.checked }))} />
                Active
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "#fbbf24" }}>
                <input type="checkbox" checked={newPkg.discount_active ?? false}
                  onChange={e => setNewPkg(p => ({ ...p, discount_active: e.target.checked }))} />
                Discount Active
              </label>
              <button onClick={handleAddPkg} disabled={addingPkg}
                style={{ background: "linear-gradient(135deg,#4ade80,#16a34a)", color: "#052e16", border: "none", borderRadius: 8, padding: "7px 16px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                <Plus size={12} style={{ marginRight: 4 }} />Add Package
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── E) Payment Methods Display (v1.6) ────────────────────────── */}
      {section === "methods" && (
        <div style={S.section}>
          <div style={S.heading}>Payment Methods Display</div>
          <div style={{ ...S.card, borderColor: "rgba(96,165,250,0.2)", marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "#93c5fd", lineHeight: 1.6 }}>
              <Info size={11} style={{ marginRight: 4 }} />
              Control which payment methods are visible to students in the
              Top-Up modal. Disabled methods are removed from the UI
              entirely — no greyed-out buttons, no labels, no instructions.
              <span style={{ display: "block", marginTop: 6, color: "#a78bfa", fontSize: 11 }}>
                Note: KHQR only appears to students when the admin toggle is ON
                AND the CamRapidPay provider is configured (env keys present).
              </span>
            </div>
          </div>

          {methodsLoading && !methods && (
            <div style={{ color: "#6b7280", fontSize: 13 }}>Loading…</div>
          )}

          {methods && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <MethodRow
                methodKey="aba"
                title="ABA Pay"
                subtitle="Native ABA / manual matching flow"
                Icon={ShieldCheck}
                meta={methods.aba}
                saving={methodsSaving}
                onToggle={() => patchMethod("aba", !methods.aba.enabled)}
              />
              <MethodRow
                methodKey="khqr"
                title="KHQR Payment"
                subtitle="CamRapidPay-powered KHQR (in-PWA checkout)"
                Icon={QrCode}
                meta={methods.khqr}
                saving={methodsSaving}
                onToggle={() => patchMethod("khqr", !methods.khqr.enabled)}
              />
            </div>
          )}
        </div>
      )}

      {/* ── D) Manual paste ──────────────────────────────────────────── */}
      {section === "manual" && (
        <div style={S.section}>
          <div style={S.heading}>Manual Notification Paste</div>
          <div style={{ ...S.card, borderColor: "rgba(251,191,36,0.2)" }}>
            <div style={{ fontSize: 12, color: "#fde68a", marginBottom: 14, lineHeight: 1.7 }}>
              <Clipboard size={11} style={{ marginRight: 4 }} />
              Use this fallback when the Telegram automation is unavailable.
              Paste the PayWay notification message and the system will parse and store it.
              <br /><br />
              Expected format: <code style={{ fontSize: 10, background: "rgba(0,0,0,0.3)", padding: "1px 5px", borderRadius: 4 }}>
                $1.00 paid by Name (*111) on May 08, 02:40 PM via ABA KHQR at DREnglish by D.YON. Trx. ID: 177822602459916, APV: 698034.
              </code>
            </div>
            <textarea
              rows={5}
              placeholder="Paste the ABA PayWay Telegram notification here…"
              value={manualMsg}
              onChange={e => setManualMsg(e.target.value)}
              style={{
                width: "100%", boxSizing: "border-box",
                background: "rgba(20,14,32,0.7)", border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 10, padding: "10px 12px", color: "#fff", fontSize: 13,
                fontFamily: "monospace", resize: "vertical", lineHeight: 1.6,
              }}
            />
            <button
              onClick={handleManualParse}
              disabled={manualLoading || !manualMsg.trim()}
              style={{
                marginTop: 10, background: "linear-gradient(135deg,#FFE19A,#D4A843)",
                color: "#1a1420", border: "none", borderRadius: 10,
                padding: "8px 20px", fontWeight: 700, fontSize: 12,
                cursor: (manualLoading || !manualMsg.trim()) ? "not-allowed" : "pointer",
                opacity: manualLoading ? 0.6 : 1,
              }}
            >
              <Send size={12} style={{ marginRight: 5 }} />
              {manualLoading ? "Parsing…" : "Parse & Ingest"}
            </button>

            {manualResult && (
              <div style={{
                marginTop: 14, padding: 12, borderRadius: 10,
                background: manualResult.error ? "rgba(248,113,113,0.1)" : "rgba(74,222,128,0.08)",
                border: `1px solid ${manualResult.error ? "rgba(248,113,113,0.3)" : "rgba(74,222,128,0.25)"}`,
              }}>
                {manualResult.error ? (
                  <div style={{ color: "#f87171", fontSize: 12 }}>❌ {manualResult.error}</div>
                ) : manualResult.duplicate ? (
                  <div style={{ color: "#fbbf24", fontSize: 12 }}>⚠️ Duplicate — already recorded (Trx. ID {manualResult.txn_id})</div>
                ) : (
                  <div style={{ fontSize: 12, color: "#4ade80" }}>
                    ✅ Ingested — Txn ID: {manualResult.txn_id}
                    <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, color: "#e5e7eb" }}>
                      {Object.entries(manualResult.parsed || {}).map(([k, v]) => (
                        <div key={k}><span style={{ color: "#6b7280" }}>{k}: </span>{String(v)}</div>
                      ))}
                    </div>
                    <div style={{ marginTop: 6, color: "#a78bfa", fontSize: 11 }}>
                      Matching is running in the background. Check Transactions tab for result.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Webhook info */}
          <div style={{ ...S.card, borderColor: "rgba(96,165,250,0.15)", marginTop: 6 }}>
            <div style={{ fontSize: 12, color: "#93c5fd", lineHeight: 1.7 }}>
              <Zap size={11} style={{ marginRight: 4 }} />
              <strong>Telegram Automation</strong> — To automate this, set up a bot or forwarder
              that sends PayWay group messages to:<br />
              <code style={{ fontSize: 11, background: "rgba(0,0,0,0.35)", padding: "2px 6px", borderRadius: 5, display: "inline-block", marginTop: 4 }}>
                POST /api/payments/telegram-webhook
              </code><br />
              Body: <code style={{ fontSize: 11 }}>{`{ "message": "<PayWay text>" }`}</code><br />
              Optional: set <code style={{ fontSize: 11 }}>PAYMENT_WEBHOOK_SECRET</code> env var
              and send it as <code style={{ fontSize: 11 }}>X-Payment-Secret</code> header for security.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
