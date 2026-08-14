/**
 * VoucherBanner.jsx — Library voucher-ready banner (reward-kind v1.0.2).
 *
 * Shown when the student arrives at /library?voucher=CODE (from the Login
 * Reward popup "Use Voucher" button, or the portal Voucher Hub). It looks the
 * voucher up via the Mongo-backed /api/student/vouchers endpoint to display
 * rich, trustworthy details (discount, eligible books, "works with all
 * books", expiry, live status). The actual discount is ALWAYS applied and
 * validated by the existing backend coupon flow inside PurchaseModal — this
 * banner is guidance only and never computes or trusts a discount itself.
 *
 * Exports readActiveVoucherCode() so PurchaseModal can prefill the coupon
 * field from the same ?voucher= query param.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Ticket, X, BookOpen, Sparkles, Clock } from "lucide-react";
import { listStudentVouchers } from "../../../lib/voucherApi";

/** Read the active voucher code from the ?voucher= query param (uppercased). */
export function readActiveVoucherCode() {
  try {
    const sp = new URLSearchParams(window.location.search);
    return (sp.get("voucher") || "").trim().toUpperCase();
  } catch {
    return "";
  }
}

function formatExpiry(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export default function VoucherBanner({ books }) {
  const location = useLocation();
  const code = useMemo(() => {
    try {
      const sp = new URLSearchParams(location.search || window.location.search);
      return (sp.get("voucher") || "").trim().toUpperCase();
    } catch {
      return "";
    }
  }, [location.search]);

  const [voucher, setVoucher] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!code) return;
    setLoaded(false);
    setVoucher(null);
    (async () => {
      try {
        const res = await listStudentVouchers();
        if (!alive) return;
        const list = (res && res.vouchers) || [];
        const match = list.find(
          (v) => (v.coupon_code || "").toUpperCase() === code
        );
        setVoucher(match || null);
      } catch {
        if (alive) setVoucher(null);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [code]);

  // Resolve eligible book slugs → titles using the Library catalog if given.
  const eligibleTitles = useMemo(() => {
    if (!voucher || voucher.applies_to_all_books) return [];
    const slugs = voucher.eligible_books || voucher.book_slugs || [];
    if (!slugs.length) return [];
    const bySlug = {};
    (books || []).forEach((b) => {
      if (b && b.slug) bySlug[b.slug] = b.title || b.name || b.slug;
    });
    return slugs.map((s) => bySlug[s] || s);
  }, [voucher, books]);

  if (!code || dismissed) return null;

  const accent = voucher?.accent_color || "#D4A843";
  const status = voucher?.status || "active";
  const inactive = loaded && voucher && status !== "active";

  return (
    <section
      data-testid="library-voucher-banner"
      className="mx-auto mb-4 max-w-[860px]"
      style={{
        borderRadius: 16,
        padding: "14px 16px",
        background: "linear-gradient(135deg, rgba(42,26,74,0.92), rgba(26,20,32,0.92))",
        border: `1px solid ${accent}55`,
        boxShadow: "0 12px 28px rgba(0,0,0,0.28)",
        position: "relative",
        color: "#F4ECD8",
      }}
    >
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss voucher banner"
        data-testid="library-voucher-dismiss"
        style={{
          position: "absolute", top: 10, right: 10, background: "transparent",
          border: "none", color: "#cdb98f", cursor: "pointer", padding: 4,
        }}
      >
        <X className="h-4 w-4" />
      </button>

      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div
          style={{
            flexShrink: 0, width: 40, height: 40, borderRadius: 12,
            background: accent, display: "grid", placeItems: "center",
            color: "#1a1420",
          }}
        >
          <Ticket className="h-5 w-5" />
        </div>

        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "#cdb98f" }}>
            {inactive ? "Voucher unavailable" : "Voucher ready"}
          </div>

          {voucher ? (
            <>
              <div style={{ fontSize: 17, fontWeight: 800, marginTop: 1 }}>
                {voucher.discount_label || "Book voucher"}
                {voucher.title ? (
                  <span style={{ fontWeight: 500, opacity: 0.8 }}> · {voucher.title}</span>
                ) : null}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                {voucher.applies_to_all_books ? (
                  <span style={pillStyle}>
                    <Sparkles className="h-3 w-3" /> Works with all books
                  </span>
                ) : (
                  <span style={pillStyle}>
                    <BookOpen className="h-3 w-3" />
                    {eligibleTitles.length
                      ? `Valid on: ${eligibleTitles.slice(0, 3).join(", ")}${eligibleTitles.length > 3 ? ` +${eligibleTitles.length - 3} more` : ""}`
                      : "Valid on selected books"}
                  </span>
                )}
                {formatExpiry(voucher.expires_at) ? (
                  <span style={pillStyle}>
                    <Clock className="h-3 w-3" /> Expires {formatExpiry(voucher.expires_at)}
                  </span>
                ) : null}
              </div>

              <div style={{ fontSize: 12, color: "#cdb98f", marginTop: 8 }}>
                {inactive
                  ? status === "used"
                    ? "This voucher has already been used."
                    : status === "expired"
                      ? "This voucher has expired."
                      : "This voucher is no longer available."
                  : voucher.applies_to_all_books
                    ? "Open any book and tap Unlock — your code is filled in and applied automatically."
                    : "Open an eligible book above and tap Unlock — your code is filled in and applied automatically."}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 17, fontWeight: 800, marginTop: 1 }}>
                Code <code style={{ userSelect: "all", letterSpacing: "0.06em" }}>{code}</code> is ready
              </div>
              <div style={{ fontSize: 12, color: "#cdb98f", marginTop: 8 }}>
                {loaded
                  ? "Open a book and tap Unlock — we'll fill in your code so you can apply it at checkout."
                  : "Checking your voucher…"}
              </div>
            </>
          )}

          {/* Coupon code chip (selectable DOM text) */}
          <div
            style={{
              display: "inline-flex", alignItems: "center", gap: 8, marginTop: 10,
              padding: "6px 10px", borderRadius: 10,
              background: "rgba(212,168,67,0.12)", border: `1px dashed ${accent}`,
            }}
          >
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "#cdb98f" }}>
              Code
            </span>
            <code
              data-testid="library-voucher-code"
              style={{ fontSize: 14, fontWeight: 800, letterSpacing: "0.08em", color: "#F4ECD8", userSelect: "all" }}
            >
              {code}
            </code>
          </div>
        </div>
      </div>
    </section>
  );
}

const pillStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  fontWeight: 600,
  padding: "4px 9px",
  borderRadius: 999,
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.14)",
  color: "#F4ECD8",
};
