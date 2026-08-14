/**
 * CouponStudio.jsx — Coupon management panel for Author/Teacher Studio.
 * Surgical addition: zero existing files modified.
 * Communicates with /api/coupons/* endpoints added to server.py.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Tag, Plus, RefreshCw, ToggleLeft, ToggleRight,
  Trash2, ChevronDown, ChevronUp, Copy, Check,
  AlertTriangle, Sparkles, Users, BookOpen, Calendar,
  Percent, Hash, Activity, Mic, Clapperboard,
} from "lucide-react";
import {
  listCoupons, createCoupon, updateCoupon, deleteCoupon,
} from "./api";
// v10.1 — shared pickers for student and book selection
import { MultiStudentPicker, BookPicker, useStudentList, useBookList } from "./components/StudioPickers";

/* ── helpers ─────────────────────────────────────────────────────────── */
function fmt(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return iso; }
}

function Badge({ children, color = "gold", ...rest }) {
  const colors = {
    gold:    { bg: "rgba(212,168,67,0.15)",  border: "rgba(212,168,67,0.4)",  text: "#FFE19A" },
    green:   { bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.35)", text: "#6ee7b7" },
    red:     { bg: "rgba(255,100,100,0.12)", border: "rgba(255,100,100,0.3)", text: "#fca5a5" },
    muted:   { bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.12)", text: "#9ca3af" },
    blue:    { bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.3)",  text: "#93c5fd" },
  };
  const c = colors[color] || colors.muted;
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }} {...rest}>
      {children}
    </span>
  );
}

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
            className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-faded hover:text-parchment hover:bg-white/10 transition"
            title="Copy code">
      {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/* ── create form ─────────────────────────────────────────────────────── */
// §Checkpoint 2: "purpose" is a FORM-ONLY concept — it maps to the backend's
// `benefit_type` field ("book_discount" default | "edutalk_points" |
// "video_library_points", the last added when Video Library Voucher
// creation was closed as a gap — see coupon_tools.py's own extended
// whitelist). The internal values stay "edutalk_points"/"video_library_
// points" (matching the backend/tests); user-facing labels say "Live Voice
// Coach Coupon" / "Video Library Voucher".
const BLANK_FORM = {
  purpose: "book_discount", // "book_discount" | "edutalk_live_coupon" | "video_library_points" (form-only key)
  code: "", type: "percent", value: "", max_uses: "",
  assigned_to: "", book_slugs: "", valid_from: "", expires_at: "",
  edutalk_amount: "",
  video_library_amount: "",
};

const MAX_EDUTALK_AMOUNT = 1000;
const MAX_VIDEO_LIBRARY_AMOUNT = 1000;

function PurposeSegmented({ value, onChange }) {
  const opts = [
    { key: "book_discount", label: "Book Discount", Icon: BookOpen },
    { key: "edutalk_live_coupon", label: "Live Voice Coach Coupon", Icon: Mic },
    { key: "video_library_points", label: "Video Library Voucher", Icon: Clapperboard },
  ];
  return (
    <div className="inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-1 gap-1" data-testid="coupon-purpose-segmented">
      {opts.map(({ key, label, Icon }) => (
        <button key={key} type="button" onClick={() => onChange(key)}
                data-testid={`coupon-purpose-${key}`}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-semibold transition ${
                  value === key ? "text-ink" : "text-faded hover:text-parchment"
                }`}
                style={value === key ? { background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" } : undefined}>
          <Icon className="h-3.5 w-3.5" /> {label}
        </button>
      ))}
    </div>
  );
}

function CreateForm({ onCreated }) {
  const [form, setForm] = useState(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);
  // v10.1 — load students and books for the pickers
  const { students, loading: stuLoading, error: stuError } = useStudentList();
  const { books, loading: bookLoading, error: bookError } = useBookList();

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleGenerate = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    set("code", Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""));
  };

  const isEduTalk = form.purpose === "edutalk_live_coupon";
  const isVideoLibrary = form.purpose === "video_library_points";
  const isBookDiscount = !isEduTalk && !isVideoLibrary;

  const handleSubmit = async () => {
    setErr(null);
    const shared = {
      code:        form.code.trim().toUpperCase() || undefined,
      max_uses:    form.max_uses ? Number(form.max_uses) : null,
      assigned_to: form.assigned_to ? form.assigned_to.split(/[\s,]+/).map(s => s.trim()).filter(Boolean) : [],
      valid_from:  form.valid_from  ? new Date(form.valid_from).toISOString()  : null,
      expires_at:  form.expires_at  ? new Date(form.expires_at).toISOString()  : null,
    };
    let payload;
    if (isEduTalk) {
      // §Checkpoint 2: Live Voice Coach Coupon — strict integer validation,
      // matching the backend's own (1-1000) check exactly so a bad value is
      // caught here before any network round-trip.
      const amt = Number(form.edutalk_amount);
      if (
        form.edutalk_amount === "" || !Number.isInteger(amt) ||
        amt < 1 || amt > MAX_EDUTALK_AMOUNT
      ) {
        setErr(`Live Voice Coach points must be a whole number between 1 and ${MAX_EDUTALK_AMOUNT}.`);
        return;
      }
      payload = {
        ...shared,
        // §Checkpoint 3 stabilization: the backend now branches validation
        // by benefit_type directly, so no dummy type/value pair is needed
        // (or wanted) for a Live Voice Coach Coupon.
        book_slugs: [],
        benefit_type: "edutalk_points",
        benefit_amount: amt,
      };
    } else if (isVideoLibrary) {
      // Video Library Voucher — same flat-points-grant shape as the Live
      // Voice Coach Coupon above (see coupon_tools.py's create_coupon,
      // which validates both identically), just its own benefit_type so
      // video_library_coupon_tools.py's isolated redemption routes are the
      // only thing that can ever redeem it.
      const amt = Number(form.video_library_amount);
      if (
        form.video_library_amount === "" || !Number.isInteger(amt) ||
        amt < 1 || amt > MAX_VIDEO_LIBRARY_AMOUNT
      ) {
        setErr(`Video Library points must be a whole number between 1 and ${MAX_VIDEO_LIBRARY_AMOUNT}.`);
        return;
      }
      payload = {
        ...shared,
        book_slugs: [],
        benefit_type: "video_library_points",
        benefit_amount: amt,
      };
    } else {
      // Book Discount — payload is byte-for-byte identical to before
      // Checkpoint 2 (no benefit_type/benefit_amount keys sent at all).
      if (!form.value || isNaN(Number(form.value)) || Number(form.value) <= 0) {
        setErr("Discount value must be a positive number.");
        return;
      }
      payload = {
        ...shared,
        type:        form.type,
        value:       Number(form.value),
        book_slugs:  form.book_slugs ? form.book_slugs.split(/[\s,]+/).map(s => s.trim()).filter(Boolean) : [],
      };
    }
    setSaving(true);
    try {
      const res = await createCoupon(payload);
      setOk(res.coupon.code);
      setForm(BLANK_FORM);
      onCreated?.();
      setTimeout(() => setOk(null), 3000);
    } catch (e) {
      setErr(e.message || "Failed to create coupon.");
    } finally {
      setSaving(false);
    }
  };

  const Row = ({ label, children }) => (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-faded mb-1">{label}</label>
      {children}
    </div>
  );

  const inp = "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-parchment placeholder-faded focus:border-gold/40 focus:outline-none transition";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 mb-6">
      <h3 className="font-display text-[15px] text-parchment mb-4 flex items-center gap-2">
        <Plus className="h-4 w-4 text-gold" /> Create New Coupon
      </h3>

      <div className="mb-4">
        <label className="block text-[10px] uppercase tracking-wider text-faded mb-1.5">Coupon Purpose</label>
        <PurposeSegmented value={form.purpose} onChange={(v) => set("purpose", v)} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <Row label="Code (leave blank to auto-generate)">
          <div className="flex gap-2">
            <input className={`${inp} flex-1`} value={form.code}
                   onChange={e => set("code", e.target.value.toUpperCase())}
                   placeholder="e.g. SUMMER20" maxLength={24} />
            <button onClick={handleGenerate} title="Auto-generate"
                    className="inline-flex items-center gap-1 rounded-lg border border-gold/30 bg-gold/10 px-3 text-[11px] font-bold text-gold hover:bg-gold/20 transition">
              <Sparkles className="h-3 w-3" /> Gen
            </button>
          </div>
        </Row>

        {isBookDiscount && (
          <>
            <Row label="Discount Type">
              <select className={inp} value={form.type} onChange={e => set("type", e.target.value)}
                      data-testid="coupon-book-discount-type">
                <option value="percent">Percentage (%)</option>
                <option value="fixed">Fixed Points (pts off)</option>
              </select>
            </Row>

            <Row label={form.type === "percent" ? "Discount Value (%)" : "Points Off"}>
              <input type="number" className={inp} value={form.value}
                     onChange={e => set("value", e.target.value)}
                     data-testid="coupon-book-discount-value"
                     placeholder={form.type === "percent" ? "e.g. 20" : "e.g. 10"} min={1} max={form.type === "percent" ? 100 : undefined} />
            </Row>
          </>
        )}

        {isEduTalk && (
          <Row label="Live Voice Coach Points">
            <input type="number" className={inp} value={form.edutalk_amount}
                   onChange={e => set("edutalk_amount", e.target.value)}
                   data-testid="coupon-edutalk-amount"
                   placeholder="e.g. 20" min={1} max={MAX_EDUTALK_AMOUNT} step={1} />
          </Row>
        )}

        {isVideoLibrary && (
          <Row label="Video Library Points">
            <input type="number" className={inp} value={form.video_library_amount}
                   onChange={e => set("video_library_amount", e.target.value)}
                   data-testid="coupon-video-library-amount"
                   placeholder="e.g. 20" min={1} max={MAX_VIDEO_LIBRARY_AMOUNT} step={1} />
          </Row>
        )}

        <Row label="Max Uses (blank = unlimited)">
          <input type="number" className={inp} value={form.max_uses}
                 onChange={e => set("max_uses", e.target.value)}
                 placeholder="e.g. 50" min={1} />
        </Row>

        <Row label="Valid From (blank = now)">
          <input type="date" className={inp} value={form.valid_from}
                 onChange={e => set("valid_from", e.target.value)} />
        </Row>

        <Row label="Expires At (blank = never)">
          <input type="date" className={inp} value={form.expires_at}
                 onChange={e => set("expires_at", e.target.value)} />
        </Row>

        <Row label="Assign to students  ·  leave blank for all">
          <MultiStudentPicker
            value={form.assigned_to}
            onChange={(v) => set("assigned_to", v)}
            students={students}
            loading={stuLoading}
            error={stuError}
            testid="coupon-assigned-to-picker"
          />
        </Row>

        {isBookDiscount && (
          <Row label="Restrict to books  ·  leave blank for all">
            <BookPicker
              value={form.book_slugs}
              onChange={(v) => set("book_slugs", v)}
              books={books}
              loading={bookLoading}
              error={bookError}
              testid="coupon-book-slugs-picker"
            />
          </Row>
        )}
      </div>

      {isEduTalk && (
        <div className="mb-4 rounded-xl border border-gold/20 bg-gold/[0.04] p-3" data-testid="coupon-edutalk-preview">
          <p className="text-[12.5px] font-semibold text-parchment flex items-center gap-1.5">
            <Mic className="h-3.5 w-3.5 text-gold" /> Live Voice Coach Coupon
          </p>
          <p className="text-[11.5px] text-parchment/75 mt-0.5">
            Adds {form.edutalk_amount || "N"} EduTalk points when redeemed inside Live Voice Coach.
          </p>
          <p className="text-[10.5px] text-faded mt-1.5">
            Students redeem this code from the Live Voice Coach dashboard.
          </p>
          <p className="text-[10.5px] text-amber-300/80 mt-1" data-testid="coupon-edutalk-disabled-note">
            Student redemption is currently disabled until launch.
          </p>
        </div>
      )}

      {isVideoLibrary && (
        <div className="mb-4 rounded-xl border border-gold/20 bg-gold/[0.04] p-3" data-testid="coupon-video-library-preview">
          <p className="text-[12.5px] font-semibold text-parchment flex items-center gap-1.5">
            <Clapperboard className="h-3.5 w-3.5 text-gold" /> Video Library Voucher
          </p>
          <p className="text-[11.5px] text-parchment/75 mt-0.5">
            Adds {form.video_library_amount || "N"} EduHub Points to the student's balance when
            redeemed inside the Video Library — spendable immediately on any lesson.
          </p>
          <p className="text-[10.5px] text-faded mt-1.5">
            Students redeem this from the "Have a voucher?" link on the Video Library home screen.
          </p>
          <p className="text-[10.5px] text-amber-300/80 mt-1" data-testid="coupon-video-library-disabled-note">
            Requires the Video Library voucher feature to be enabled on the server.
          </p>
        </div>
      )}

      {err && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-400/25 bg-red-900/20 px-3 py-2 text-[12px] text-red-300">
          <AlertTriangle className="h-3.5 w-3.5 flex-none" /> {err}
        </div>
      )}
      {ok && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-green-400/25 bg-green-900/20 px-3 py-2 text-[12px] text-green-300">
          <Check className="h-3.5 w-3.5 flex-none" /> Coupon <strong>{ok}</strong> created successfully!
        </div>
      )}

      <button onClick={handleSubmit} disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-[12px] font-bold uppercase tracking-wider text-ink disabled:opacity-50 transition"
              style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
        {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        {saving ? "Creating…" : "Create Coupon"}
      </button>
    </div>
  );
}

/* ── coupon row ──────────────────────────────────────────────────────── */
function CouponRow({ coupon, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const isExpired = coupon.expires_at && new Date(coupon.expires_at) < new Date();
  const isFull    = coupon.max_uses != null && coupon.uses_count >= coupon.max_uses;
  // §Checkpoint 2: old coupons have no benefit_type at all — default matches
  // the backend's own `.get("benefit_type") or "book_discount"` fallback
  // exactly, so a pre-existing coupon renders identically to before.
  const isEduTalkCoupon = (coupon.benefit_type || "book_discount") === "edutalk_points";
  const isVideoLibraryCoupon = coupon.benefit_type === "video_library_points";
  // Both are a flat points grant with the SAME redemption-entry shape
  // (status/benefit_amount/credited_at) — only the badge label/icon and the
  // benefit description text differ between them.
  const isPointsCoupon = isEduTalkCoupon || isVideoLibraryCoupon;

  const statusColor = !coupon.enabled ? "muted"
    : isExpired ? "red"
    : isFull    ? "red"
    : "green";

  const statusLabel = !coupon.enabled ? "Disabled"
    : isExpired ? "Expired"
    : isFull    ? "Exhausted"
    : "Active";

  const handleToggle = async () => {
    setToggling(true);
    try { await updateCoupon(coupon.code, { enabled: !coupon.enabled }); onRefresh(); }
    catch { /* ignore */ }
    finally { setToggling(false); }
  };

  const handleDelete = async () => {
    if (!confirmDel) { setConfirmDel(true); setTimeout(() => setConfirmDel(false), 3000); return; }
    setDeleting(true);
    try { await deleteCoupon(coupon.code); onRefresh(); }
    catch { /* ignore */ }
    finally { setDeleting(false); }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.025] overflow-hidden mb-2">
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Code */}
        <div className="flex-none">
          <span className="font-mono text-[15px] font-bold text-parchment tracking-widest">{coupon.code}</span>
          <CopyBtn text={coupon.code} />
        </div>
        {/* Status */}
        <Badge color={statusColor}>{statusLabel}</Badge>
        {/* Purpose + value */}
        {isEduTalkCoupon ? (
          <Badge color="gold" data-testid={`coupon-purpose-badge-${coupon.code}`}>
            <Mic className="h-2.5 w-2.5" /> Live Voice Coach Coupon · {coupon.benefit_amount ?? "?"} pts
          </Badge>
        ) : isVideoLibraryCoupon ? (
          <Badge color="gold" data-testid={`coupon-purpose-badge-${coupon.code}`}>
            <Clapperboard className="h-2.5 w-2.5" /> Video Library Voucher · {coupon.benefit_amount ?? "?"} pts
          </Badge>
        ) : (
          <Badge color="blue">
            {coupon.type === "percent"
              ? <><Percent className="h-2.5 w-2.5" /> {coupon.value}% off</>
              : <><Hash className="h-2.5 w-2.5" /> {coupon.value} pts off</>}
          </Badge>
        )}
        {/* Usage */}
        <span className="text-[11px] text-faded ml-auto">
          {coupon.uses_count}/{coupon.max_uses ?? "∞"} uses
        </span>
        {/* Toggle enable */}
        <button onClick={handleToggle} disabled={toggling} title={coupon.enabled ? "Disable" : "Enable"}
                className="text-faded hover:text-parchment transition disabled:opacity-40">
          {coupon.enabled
            ? <ToggleRight className="h-5 w-5 text-green-400" />
            : <ToggleLeft  className="h-5 w-5" />}
        </button>
        {/* Delete */}
        <button onClick={handleDelete} disabled={deleting}
                className={`transition disabled:opacity-40 ${confirmDel ? "text-red-400" : "text-faded hover:text-red-400"}`}
                title={confirmDel ? "Tap again to confirm" : "Delete"}>
          <Trash2 className="h-4 w-4" />
        </button>
        {/* Expand */}
        <button onClick={() => setExpanded(!expanded)} className="text-faded hover:text-parchment transition">
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-white/8 px-4 py-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-faded mb-1 flex items-center gap-1">
              <Calendar className="h-3 w-3" /> Dates
            </p>
            <p className="text-[12px] text-parchment">From: {fmt(coupon.valid_from)}</p>
            <p className="text-[12px] text-parchment">Expires: {fmt(coupon.expires_at)}</p>
            <p className="text-[12px] text-parchment">Created: {fmt(coupon.created_at)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-faded mb-1 flex items-center gap-1">
              <Users className="h-3 w-3" /> Assigned To
            </p>
            <p className="text-[12px] text-parchment">
              {(coupon.assigned_to || []).length === 0
                ? "All students (public)"
                : (coupon.assigned_to || []).join(", ")}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-faded mb-1 flex items-center gap-1">
              {isEduTalkCoupon ? <><Mic className="h-3 w-3" /> Benefit</>
                : isVideoLibraryCoupon ? <><Clapperboard className="h-3 w-3" /> Benefit</>
                : <><BookOpen className="h-3 w-3" /> Books</>}
            </p>
            <p className="text-[12px] text-parchment">
              {isEduTalkCoupon
                ? `${coupon.benefit_amount ?? "?"} EduTalk points (Live Voice Coach)`
                : isVideoLibraryCoupon
                ? `${coupon.benefit_amount ?? "?"} EduHub points (Video Library)`
                : (coupon.book_slugs || []).length === 0
                ? "All books"
                : (coupon.book_slugs || []).join(", ")}
            </p>
          </div>

          {/* Redemption history — the points-grant shape (status/credited_at,
              SHARED identically by edutalk_points and video_library_points)
              is distinct from the book-discount shape (book_slug/original/
              discounted); rendering the wrong columns for old coupons that
              never set benefit_type at all must never crash, so every field
              read here is defensively optional. */}
          {(coupon.redemptions || []).length > 0 && (
            <div className="sm:col-span-3" data-testid={`coupon-redemptions-${coupon.code}`}>
              <p className="text-[10px] uppercase tracking-wider text-faded mb-2 flex items-center gap-1">
                <Activity className="h-3 w-3" /> Redemption History ({coupon.redemptions.length})
              </p>
              <div className="rounded-lg border border-white/8 overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-white/8 text-faded">
                      <th className="text-left px-3 py-2">Student</th>
                      {isPointsCoupon ? (
                        <>
                          <th className="text-left px-3 py-2">Status</th>
                          <th className="text-left px-3 py-2">Points</th>
                          <th className="text-left px-3 py-2">Credited</th>
                        </>
                      ) : (
                        <>
                          <th className="text-left px-3 py-2">Book</th>
                          <th className="text-left px-3 py-2">Original</th>
                          <th className="text-left px-3 py-2">Paid</th>
                          <th className="text-left px-3 py-2">Date</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {(coupon.redemptions || []).slice().reverse().map((r, i) => (
                      <tr key={i} className="border-b border-white/5 text-parchment/80 hover:bg-white/[0.02]">
                        <td className="px-3 py-1.5 font-mono">{r?.student_id ?? "—"}</td>
                        {isPointsCoupon ? (
                          <>
                            <td className="px-3 py-1.5 capitalize">{(r?.status || "—").replace("_", " ")}</td>
                            <td className="px-3 py-1.5 text-green-400">{r?.benefit_amount ?? "—"} pts</td>
                            <td className="px-3 py-1.5">{fmt(r?.credited_at)}</td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-1.5">{r?.book_slug ?? "—"}</td>
                            <td className="px-3 py-1.5">{r?.original ?? "—"} pts</td>
                            <td className="px-3 py-1.5 text-green-400">{r?.discounted ?? "—"} pts</td>
                            <td className="px-3 py-1.5">{fmt(r?.redeemed_at)}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {(coupon.redemptions || []).length === 0 && (
            <div className="sm:col-span-3 text-[12px] text-faded italic">No redemptions yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── main panel ──────────────────────────────────────────────────────── */
export default function CouponStudio() {
  const [coupons, setCoupons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await listCoupons();
      setCoupons(res.coupons || []);
    } catch (e) {
      setErr(e.message || "Failed to load coupons.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const active   = coupons.filter(c => c.enabled && (!c.expires_at || new Date(c.expires_at) > new Date()) && (c.max_uses == null || c.uses_count < c.max_uses));
  const inactive = coupons.filter(c => !active.includes(c));

  return (
    <div className="space-y-4" data-testid="coupon-studio">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-display text-[20px] text-parchment flex items-center gap-2">
            <Tag className="h-5 w-5 text-gold" /> Coupon Management
          </h2>
          <p className="text-[12px] text-faded mt-0.5">
            Create, manage and monitor discount coupons for the library.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading} title="Refresh"
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] text-parchment hover:border-gold/40 transition disabled:opacity-40">
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          <button onClick={() => setShowCreate(!showCreate)}
                  className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink transition"
                  style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 55%, #9C7A2C 100%)" }}>
            <Plus className="h-3 w-3" /> New Coupon
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total",    value: coupons.length,   color: "text-parchment" },
          { label: "Active",   value: active.length,    color: "text-green-400" },
          { label: "Inactive", value: inactive.length,  color: "text-faded"     },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center">
            <p className={`font-display text-[22px] font-bold ${color}`}>{value}</p>
            <p className="text-[10px] uppercase tracking-wider text-faded">{label}</p>
          </div>
        ))}
      </div>

      {/* Create form */}
      {showCreate && <CreateForm onCreated={() => { load(); setShowCreate(false); }} />}

      {/* Error */}
      {err && (
        <div className="flex items-center gap-2 rounded-lg border border-red-400/25 bg-red-900/20 px-3 py-2 text-[12px] text-red-300">
          <AlertTriangle className="h-3.5 w-3.5 flex-none" /> {err}
        </div>
      )}

      {/* List */}
      {loading && (
        <div className="text-center py-10 text-faded text-[12px]">Loading coupons…</div>
      )}

      {!loading && coupons.length === 0 && (
        <div className="text-center py-12 rounded-2xl border border-dashed border-white/15">
          <Tag className="h-8 w-8 text-faded mx-auto mb-3" />
          <p className="text-[13px] text-faded">No coupons yet. Create your first one above.</p>
        </div>
      )}

      {!loading && coupons.length > 0 && (
        <div>
          {active.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] uppercase tracking-wider text-faded mb-2 flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-green-400 inline-block" /> Active ({active.length})
              </p>
              {active.map(c => <CouponRow key={c.code} coupon={c} onRefresh={load} />)}
            </div>
          )}
          {inactive.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-faded mb-2 flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-gray-500 inline-block" /> Inactive / Expired ({inactive.length})
              </p>
              {inactive.map(c => <CouponRow key={c.code} coupon={c} onRefresh={load} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
