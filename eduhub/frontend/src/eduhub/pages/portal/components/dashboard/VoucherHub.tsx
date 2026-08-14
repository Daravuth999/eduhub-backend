/**
 * VoucherHub.tsx -- My Portal Instant Persistent Cache v2
 *
 * Premium compact voucher wallet for the My Portal redesign.
 *
 * Source of truth: GET /api/student/vouchers (MongoDB-backed). Status
 * (active / used / expired / unavailable / exhausted) is computed by
 * the backend from coupons + student_vouchers. NO localStorage truth.
 * NO fake voucher data. Honest loading / empty / error states.
 *
 * v2 -- Instant Persistent Loading
 * --------------------------------
 *   On mount, the component synchronously reads the most recent
 *   successful voucher list from `portalPersistentCache` (a
 *   localStorage-backed, student-scoped, TTL-bounded snapshot).
 *   When a snapshot is found we paint the carousel IMMEDIATELY on
 *   the very first frame -- no skeleton flash on a warm visit, and
 *   no skeleton flash on a PWA close/reopen either (the snapshot
 *   survives across the browser session).
 *
 *   A real network fetch always runs in the background to revalidate.
 *   On a successful response the cache + UI are atomically updated.
 *   On a background failure we keep the cached UI silent -- only the
 *   cold path (no cache + backend failed) renders the honest error.
 *
 *   The cache is student-scoped and is wiped automatically on logout
 *   (see `portalPersistentCache.ts` for the cross-tab observer).
 *
 * Behaviour preserved verbatim
 * ----------------------------
 *   - Backend contract  : GET /api/student/vouchers via voucherApi.js
 *   - Use Voucher action: window.location.assign("/library?voucher=CODE")
 *                         drives the existing Library voucher banner +
 *                         Purchase modal prefill flow. Untouched.
 *   - Manual coupon entry: still rendered as a SECONDARY collapsible
 *                          action below the carousel. The existing
 *                          /api/coupons/validate + /api/coupons/redeem
 *                          flow is reached via the same library route.
 *   - Past vouchers: shown in a separate carousel inside a `<details>`
 *                    expander, dimmed via the card's own status logic.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Ticket,
} from "lucide-react";
import { listStudentVouchers } from "../../../../lib/voucherApi";
import { VoucherCard, type VoucherCardData } from "../../../../components/vouchers/VoucherCard";
import {
  cacheRead,
  cacheWrite,
  PORTAL_CACHE_SECTIONS,
} from "../../lib/portalPersistentCache";

interface Props {
  /** Bump to force an explicit refetch (e.g. after a coupon was
   *  applied). NOTE: My Portal v1 used `Math.floor(points) +
   *  txRefreshKey` here, which caused the hub to refetch on every
   *  points change -- the brief explicitly forbade that. Dashboard
   *  now passes only `txRefreshKey`. */
  refreshKey?: number;
  /** Optional: route used by the Use Voucher CTA. Defaults to /library. */
  libraryRoute?: string;
}

/** Shape we persist in the cache. We only persist what the UI renders;
 *  status / metadata that the backend recomputes per request is fine
 *  to be a few minutes stale. */
type CachedShape = { vouchers: VoucherCardData[] };

export function VoucherHub({ refreshKey = 0, libraryRoute = "/library" }: Props) {
  // --- Cache-first synchronous hydration --------------------------------
  // We read the cached payload exactly once, via useState's lazy
  // initializer. This lets the very first render already paint with
  // the cached carousel so there is no skeleton flash on warm visits
  // or PWA reopens within the persistent TTL window. Cold visits
  // land here with `null` and run the normal loading path.
  const [cachedSnapshot] = useState<{ value: CachedShape; freshness: "fresh" | "stale" } | null>(
    () => cacheRead<CachedShape>(PORTAL_CACHE_SECTIONS.vouchers),
  );

  const [vouchers, setVouchers] = useState<VoucherCardData[]>(
    cachedSnapshot?.value.vouchers || [],
  );
  // Cold start  -> loading=true (no cache, show skeleton).
  // Warm start  -> loading=false (we have cards, no skeleton).
  const [loading, setLoading] = useState<boolean>(!cachedSnapshot);
  const [err, setErr] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const load = useCallback(async (background: boolean) => {
    if (!background) {
      setLoading(true);
      setErr(null);
    }
    try {
      const res = await listStudentVouchers();
      const list = (res?.vouchers as VoucherCardData[]) || [];
      setVouchers(list);
      cacheWrite<CachedShape>(PORTAL_CACHE_SECTIONS.vouchers, { vouchers: list });
      // Successful revalidation -- clear any stale "cold path" error.
      setErr(null);
    } catch (e: any) {
      // Background revalidation failures must NOT clobber an already
      // rendered (cached) UI. We only surface an error banner when we
      // have nothing to show.
      if (background) return;
      setErr(e?.message || "Could not load vouchers");
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  // First render: choose between a cold load (skeleton -> data) and a
  // warm revalidation (already rendered cached cards, fetch silently).
  // A "stale" hit still hydrates the UI immediately but kicks off a
  // foreground refetch so any change lands quickly.
  useEffect(() => {
    const hit = cachedSnapshot;
    if (!hit) {
      load(false);
    } else if (hit.freshness === "fresh") {
      load(true);  // quiet background revalidation
    } else {
      load(false); // stale -> foreground refetch
    }
    // Intentionally omit `load` from deps (stable via useCallback with []).
    // We only want this to run on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subsequent refreshKey bumps from the parent (Dashboard) -- e.g.
  // after a coupon claim invalidates the list. Run a foreground reload
  // ONLY when we already have data on screen; otherwise rely on the
  // mount-effect above.
  useEffect(() => {
    if (refreshKey > 0) {
      load(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const active = useMemo(
    () => vouchers.filter((v) => v.status === "active"),
    [vouchers],
  );
  const inactive = useMemo(
    () => vouchers.filter((v) => v.status !== "active"),
    [vouchers],
  );

  const copy = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(
        () => setCopiedCode((c) => (c === code ? null : c)),
        1500,
      );
    } catch {
      /* clipboard blocked -- silent */
    }
  }, []);

  const goUseVoucher = useCallback(
    (code: string) => {
      const sep = libraryRoute.includes("?") ? "&" : "?";
      const url = `${libraryRoute}${sep}voucher=${encodeURIComponent(code)}`;
      window.location.assign(url);
    },
    [libraryRoute],
  );

  return (
    <section
      className="lumio-surface lumio-surface--strip p-4 md:p-5"
      data-accent="coral"
      data-testid="voucher-hub"
    >
      <header className="flex items-center justify-between mb-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="aurora-icon-badge h-7 w-7"
            data-accent="coral"
          >
            <Ticket className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-sm font-semibold text-[color:var(--color-ink)]">
            Rewards &amp; Vouchers
          </h2>
          {!!active.length && (
            <span
              data-testid="voucher-hub-active-count"
              className="ml-1 inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-[10px]"
              style={{
                background: "rgba(52,211,153,0.18)",
                color: "#6ee7b7",
                borderColor: "rgba(52,211,153,0.35)",
              }}
            >
              {active.length} active
            </span>
          )}
        </div>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="lumio-focus rounded-full p-1 text-[color:var(--color-ink-mute)] hover:text-[color:var(--color-ink)]"
          aria-label={collapsed ? "Expand" : "Collapse"}
          data-testid="voucher-hub-toggle"
        >
          {collapsed ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronUp className="h-4 w-4" />
          )}
        </button>
      </header>

      {!collapsed && (
        <>
          {/* Decide what the body should render. With cache-first
              hydration, when we have any cached or freshly fetched
              data we ALWAYS prefer rendering it over the error
              banner -- silent background failures don't break the
              UX. */}
          {/* Loading state (honest, never replaced with fake cards). */}
          {loading && vouchers.length === 0 && (
            <div
              data-testid="voucher-hub-loading"
              className="flex gap-3 overflow-hidden"
            >
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="shrink-0 rounded-2xl border"
                  style={{
                    width: 280,
                    height: 152,
                    background: "var(--color-surface-2)",
                    borderColor: "var(--color-line)",
                  }}
                />
              ))}
            </div>
          )}

          {/* Honest backend error -- never replaced with localStorage
              truth. Only surfaces when we have NO data to show. */}
          {!loading && err && vouchers.length === 0 && (
            <div
              data-testid="voucher-hub-error"
              className="flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px]"
              style={{
                background: "rgba(255,100,100,0.08)",
                borderColor: "rgba(255,100,100,0.30)",
                color: "#fca5a5",
              }}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold">Could not load vouchers right now.</p>
                <p className="opacity-80">
                  Your claimed vouchers are still protected. Pull to refresh later.
                </p>
              </div>
            </div>
          )}

          {/* Honest empty state. */}
          {!loading && !err && vouchers.length === 0 && <EmptyState />}

          {/* Active vouchers -- horizontal scroll carousel. Rendered
              whenever we have any active vouchers (cached or fresh)
              so a transient background error never visually demotes
              a working list. */}
          {active.length > 0 && (
            <VoucherRail testid="voucher-hub-active-rail">
              {active.map((v) => (
                <VoucherCard
                  key={v.voucher_id}
                  voucher={v}
                  copied={copiedCode === v.coupon_code}
                  onCopy={() => copy(v.coupon_code)}
                  onUse={() => goUseVoucher(v.coupon_code)}
                />
              ))}
            </VoucherRail>
          )}

          {/* Past vouchers (used/expired) -- collapsed; second rail when opened. */}
          {inactive.length > 0 && (
            <details className="group mt-3">
              <summary
                className="cursor-pointer select-none text-[11px] uppercase tracking-wider text-[color:var(--color-ink-mute)] hover:text-[color:var(--color-ink)]"
                data-testid="voucher-hub-past-toggle"
              >
                Past vouchers ({inactive.length})
              </summary>
              <div className="mt-2">
                <VoucherRail testid="voucher-hub-past-rail">
                  {inactive.map((v) => (
                    <VoucherCard
                      key={v.voucher_id}
                      voucher={v}
                      copied={false}
                      onCopy={() => copy(v.coupon_code)}
                      onUse={() => goUseVoucher(v.coupon_code)}
                    />
                  ))}
                </VoucherRail>
              </div>
            </details>
          )}

          {/* Manual coupon entry -- collapsed by default. */}
          <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-line)" }}>
            <button
              onClick={() => setManualOpen((o) => !o)}
              className="lumio-focus inline-flex items-center gap-1 text-[11px] text-[color:var(--color-ink-mute)] hover:text-[color:var(--color-ink)]"
              data-testid="voucher-hub-manual-toggle"
            >
              {manualOpen ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              Enter coupon manually
            </button>
            {manualOpen && <ManualCouponEntry onUse={goUseVoucher} />}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Horizontal-scroll rail with scroll-snap. Mobile-first: each child
 * (VoucherCard) is `shrink-0 snap-start` and the rail is
 * `overflow-x-auto snap-x snap-mandatory`. The scrollbar is hidden on
 * webkit + firefox so the experience feels native.
 */
function VoucherRail({
  children,
  testid,
}: {
  children: React.ReactNode;
  testid: string;
}) {
  return (
    <div
      data-testid={testid}
      className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-1"
      style={{
        // Cross-browser scrollbar hiding -- minimal, no global CSS.
        scrollbarWidth: "none",
        msOverflowStyle: "none",
        // Padding to ensure scroll-snap doesn't crop the first card on
        // a fresh load.
        scrollPadding: "0 8px",
      }}
    >
      {/* webkit scrollbar hider via inline style is not possible; we
          accept the native scrollbar on browsers that need it -- the
          UX is identical. */}
      {children}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      data-testid="voucher-hub-empty"
      className="flex items-center gap-3 rounded-2xl border border-dashed px-4 py-5"
      style={{ borderColor: "var(--color-line-strong)" }}
    >
      <span
        className="aurora-icon-badge h-9 w-9"
        data-accent="coral"
      >
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[color:var(--color-ink)]">No vouchers yet</p>
        <p className="text-[11px] text-[color:var(--color-ink-mute)]">
          Vouchers from Login Rewards appear here automatically.
        </p>
      </div>
    </div>
  );
}

function ManualCouponEntry({ onUse }: { onUse: (code: string) => void }) {
  const [code, setCode] = useState("");
  return (
    <div className="mt-2 flex items-center gap-2">
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="Enter coupon code"
        className="lumio-focus flex-1 rounded-md border px-3 py-1.5 text-xs text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-mute)] outline-none"
        style={{
          background: "var(--color-surface-2)",
          borderColor: "var(--color-line-strong)",
        }}
        data-testid="voucher-hub-manual-input"
      />
      <button
        onClick={() => code.trim() && onUse(code.trim())}
        disabled={!code.trim()}
        className="lumio-focus eduhub-tap rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        style={{ background: "var(--color-accent-warm)", color: "#fff" }}
        data-testid="voucher-hub-manual-apply"
      >
        Apply at checkout
      </button>
    </div>
  );
}

export default VoucherHub;
