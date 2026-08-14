/**
 * VoucherCard.tsx -- compact ticket-style voucher card.
 *
 * Mounted inside the My Portal `VoucherHub` horizontal carousel. The
 * card is intentionally COMPACT (~280px wide x ~140px tall on mobile)
 * so many vouchers can be browsed without the My Portal section
 * expanding vertically. Layout:
 *
 *      +------+-----------------------------------+
 *      |      |  STATUS pill           expires    |
 *      |  V   |                                    |
 *      |  O   |  $70                               |
 *      |  U   |  Voucher title                     |
 *      |  C   |  Eligible books line               |
 *      |  H   |                                    |
 *      |  E   |  code         [ Use Voucher  > ]   |
 *      |  R   |                                    |
 *      +------+-----------------------------------+
 *
 * Honesty contract:
 *   - Reads only the voucher object passed in (sourced from the
 *     authoritative /api/student/vouchers backend).
 *   - Never invents discount values, status, or expiry. Empty backend
 *     fields render an honest fallback ("Book voucher" / "No expiry").
 *   - Pure presentational. Side effects (copy, use) are delegated to
 *     callbacks owned by the parent.
 *
 * Visual language: premium dark glass with a coloured side strip per
 * template. If `artwork_url` is supplied and passes the sanitiser, it
 * paints the body with a readability overlay; otherwise the template
 * gradient is used.
 */
import { useState } from "react";
import { ChevronRight, Clock, Copy, Check } from "lucide-react";
import { resolveVoucherTemplate, safeVoucherArtworkUrl } from "../../components/vouchers/voucherTemplates";

export type VoucherStatus =
  | "active"
  | "used"
  | "expired"
  | "unavailable"
  | "exhausted";

export interface VoucherCardData {
  voucher_id: string;
  coupon_code: string;
  title: string;
  subtitle?: string;
  discount_label?: string;
  expires_at?: string | null;
  status: VoucherStatus;
  eligible_books?: string[];
  applies_to_all_books?: boolean;
  artwork_mode?: "template" | "custom_url";
  template_style?: string;
  artwork_url?: string;
  artwork_alt?: string;
  accent_color?: string;
  cta_label?: string;
}

interface Props {
  voucher: VoucherCardData;
  copied: boolean;
  onCopy: () => void;
  onUse: () => void;
}

function formatExpiry(iso?: string | null): string {
  if (!iso) return "No expiry";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Expires soon";
    return `Expires ${d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })}`;
  } catch {
    return "Expires soon";
  }
}

function statusBadge(status: VoucherStatus): { label: string; bg: string; fg: string } {
  switch (status) {
    case "active":
      return { label: "Active",   bg: "rgba(52,211,153,0.18)", fg: "#6ee7b7" };
    case "used":
      return { label: "Used",     bg: "rgba(255,255,255,0.10)", fg: "#cbd5e1" };
    case "expired":
      return { label: "Expired",  bg: "rgba(255,100,100,0.18)", fg: "#fca5a5" };
    case "exhausted":
      return { label: "Sold out", bg: "rgba(251,191,36,0.18)",  fg: "#fde68a" };
    default:
      return { label: "Off",      bg: "rgba(148,163,184,0.18)", fg: "#cbd5e1" };
  }
}

function ctaLabel(status: VoucherStatus, fallback?: string): string {
  switch (status) {
    case "used":      return "Used";
    case "expired":   return "Expired";
    case "exhausted": return "Sold out";
    case "unavailable": return "Disabled";
    default:          return fallback || "Use Voucher";
  }
}

export function VoucherCard({ voucher: v, copied, onCopy, onUse }: Props) {
  const tpl = resolveVoucherTemplate(v.template_style);
  const accent = v.accent_color || tpl.accent;
  const safeArt = safeVoucherArtworkUrl(v.artwork_url);
  const useArt = v.artwork_mode === "custom_url" && !!safeArt;
  const [imgFailed, setImgFailed] = useState(false);

  const disabled = v.status !== "active";
  const badge = statusBadge(v.status);

  const eligibleLine = v.applies_to_all_books
    ? "All eligible books"
    : v.eligible_books && v.eligible_books.length
    ? `${v.eligible_books.slice(0, 2).join(", ")}${
        v.eligible_books.length > 2 ? `, +${v.eligible_books.length - 2}` : ""
      }`
    : v.subtitle || "Selected books";

  // The discount headline. Falls back honestly when the backend did not
  // ship a discount_label (e.g. some legacy campaigns).
  const headline = (v.discount_label && v.discount_label.trim()) || "Book voucher";

  return (
    <article
      data-testid={`voucher-card-${v.voucher_id}`}
      className="relative shrink-0 snap-start overflow-hidden rounded-2xl border"
      style={{
        width: 280,
        height: 152,
        borderColor: tpl.border,
        background: tpl.body,
        boxShadow:
          "0 18px 40px -22px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05)",
        opacity: disabled ? 0.62 : 1,
        // Ticket-style scalloped edges via radial-gradient mask
        WebkitMaskImage:
          "radial-gradient(circle at 56px 8px, transparent 6px, #000 6.5px), radial-gradient(circle at 56px 144px, transparent 6px, #000 6.5px), linear-gradient(#000,#000)",
        WebkitMaskComposite: "source-in",
        maskComposite: "intersect",
      }}
    >
      {/* Custom artwork (validated) painted under the dark overlay. */}
      {useArt && !imgFailed && (
        <img
          src={safeArt}
          alt={v.artwork_alt || v.title || "Voucher"}
          onError={() => setImgFailed(true)}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {useArt && !imgFailed && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(135deg, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.45) 100%)",
          }}
        />
      )}

      <div className="relative z-10 flex h-full">
        {/* Left strip: vertical VOUCHER label. */}
        <div
          className="relative flex shrink-0 items-center justify-center"
          style={{
            width: 44,
            background: tpl.strip,
            color: tpl.text,
          }}
          aria-hidden
        >
          <span
            className="font-bold uppercase"
            style={{
              transform: "rotate(-90deg)",
              letterSpacing: "0.32em",
              fontSize: 10,
              whiteSpace: "nowrap",
            }}
          >
            Voucher
          </span>
          {/* Punch-line between strip and body (decorative). */}
          <span
            aria-hidden
            className="pointer-events-none absolute -right-px top-0 bottom-0"
            style={{
              width: 1,
              backgroundImage: `repeating-linear-gradient(180deg, ${tpl.border} 0 4px, transparent 4px 8px)`,
            }}
          />
        </div>

        {/* Body. */}
        <div className="flex min-w-0 flex-1 flex-col justify-between p-3">
          {/* Top row: status + expiry */}
          <div className="flex items-center justify-between gap-2">
            <span
              data-testid={`voucher-status-${v.voucher_id}`}
              className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest"
              style={{ background: badge.bg, color: badge.fg }}
            >
              {badge.label}
            </span>
            <span
              className="inline-flex items-center gap-1 text-[10px]"
              style={{ color: tpl.mute }}
            >
              <Clock className="h-3 w-3" />
              {formatExpiry(v.expires_at)}
            </span>
          </div>

          {/* Headline: discount label */}
          <div className="min-w-0">
            <div
              className="truncate text-2xl font-extrabold leading-none"
              style={{ color: accent }}
              data-testid={`voucher-headline-${v.voucher_id}`}
            >
              {headline}
            </div>
            <div
              className="mt-1 truncate text-[12px] font-semibold leading-tight"
              style={{ color: tpl.text }}
              title={v.title}
            >
              {v.title || "Voucher"}
            </div>
            <div
              className="truncate text-[10px]"
              style={{ color: tpl.mute }}
              title={eligibleLine}
            >
              {eligibleLine}
            </div>
          </div>

          {/* Bottom row: code + Use Voucher CTA */}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onCopy}
              data-testid={`voucher-copy-${v.voucher_id}`}
              className="group inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-widest transition-colors"
              style={{
                background: "rgba(0,0,0,0.42)",
                color: tpl.text,
                border: `1px solid ${tpl.border}`,
              }}
              aria-label="Copy voucher code"
            >
              <span className="truncate max-w-[110px]">{v.coupon_code}</span>
              {copied ? (
                <Check className="h-3 w-3 shrink-0" style={{ color: "#6ee7b7" }} />
              ) : (
                <Copy className="h-3 w-3 shrink-0" style={{ color: tpl.mute }} />
              )}
            </button>
            <button
              type="button"
              onClick={onUse}
              disabled={disabled}
              data-testid={`voucher-use-${v.voucher_id}`}
              className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition-transform disabled:cursor-not-allowed disabled:opacity-70 hover:enabled:scale-[1.02] active:enabled:scale-[0.98]"
              style={{
                background: disabled ? "rgba(255,255,255,0.08)" : accent,
                color: disabled ? tpl.mute : "#111",
              }}
            >
              {ctaLabel(v.status, v.cta_label)}
              {!disabled && <ChevronRight className="h-3 w-3" />}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

export default VoucherCard;
