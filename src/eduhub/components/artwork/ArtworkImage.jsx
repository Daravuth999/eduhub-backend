/**
 * ArtworkImage.jsx — one responsive artwork frame.
 *
 * v1.0 link-based rendering: the admin supplies ONE high-quality image_url
 * and the frame adapts it visually per placement via:
 *   • a fixed aspect-ratio container (per placement)
 *   • object-fit: cover + object-position (crop focus)
 *   • loading shimmer placeholder
 *   • graceful fallback (fallback_url, then a branded placeholder)
 *   • lightweight, admin-selected animation (transform/opacity only)
 *
 * It renders an <img> only — no business logic, no side effects.
 */
import { useState } from "react";
import { PLACEMENT_RATIO } from "./artworkConfig";

const ANIM_CLASS = {
  none: "",
  fade: "artwork-anim-fade",
  slide: "artwork-anim-slide",
  float: "artwork-anim-float",
  zoom: "artwork-anim-zoom",
  parallax: "artwork-anim-parallax",
};

export default function ArtworkImage({
  campaign,
  placement,
  onClick,
  scrim = false,
  caption = null,
  className = "",
  ratioOverride,
  testid,
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!campaign) return null;

  const ratio = ratioOverride || PLACEMENT_RATIO[placement] || "16 / 9";
  const focus = campaign.image_focus || "center";
  const animClass = ANIM_CLASS[campaign.animation || "fade"] || "";
  const src = failed ? campaign.fallback_url : campaign.image_url;
  const clickable = typeof onClick === "function";

  return (
    <div
      className={`artwork-frame ${className}`}
      style={{ aspectRatio: ratio }}
      data-clickable={clickable ? "true" : "false"}
      data-testid={testid || `artwork-frame-${placement}`}
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={(e) => {
        if (clickable && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick(e);
        }
      }}
      aria-label={campaign.name}
    >
      {!loaded && !failed && <div className="artwork-skeleton" aria-hidden />}

      {src ? (
        <img
          className={`artwork-img ${loaded ? animClass : ""}`}
          src={src}
          alt={campaign.name || "Artwork"}
          loading="lazy"
          decoding="async"
          draggable={false}
          style={{
            objectPosition: focus,
            opacity: loaded ? 1 : 0,
          }}
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (!failed && campaign.fallback_url) {
              setFailed(true);
              setLoaded(false);
            } else {
              setFailed(true);
              setLoaded(true);
            }
          }}
        />
      ) : (
        <div className="artwork-fallback">{campaign.name || "Artwork"}</div>
      )}

      {failed && !campaign.fallback_url && (
        <div className="artwork-fallback">{campaign.name || "Artwork"}</div>
      )}

      {scrim && <div className="artwork-scrim" aria-hidden />}
      {caption && <div className="artwork-caption">{caption}</div>}
    </div>
  );
}
