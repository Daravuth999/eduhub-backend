// DYLogo.jsx — official DY brand mark, used across the premium auth flow.
// Loads the bundled asset from src/assets/brand/dy-logo.png so the login
// screen never depends on a remote R2 request. If the imported asset
// somehow fails to render (image decode error, blocked, etc.) the
// component falls back to a clean text monogram "DY" so the user is
// never staring at a broken image.
import { useState } from "react";
import dyLogoSrc from "../../../assets/brand/dy-logo.png";

/**
 * Props:
 *   size:      number   pixel size of the square logo (default 88)
 *   className: string   extra Tailwind classes applied to the wrapper
 *   alt:       string   accessibility label (default "DY Learning")
 *   testID:    string   data-testid override
 */
export default function DYLogo({
  size = 88,
  className = "",
  alt = "DY Learning",
  testID = "dy-logo",
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        role="img"
        aria-label={alt}
        data-testid={`${testID}-fallback`}
        className={`inline-flex items-center justify-center rounded-2xl select-none ${className}`}
        style={{
          width: size,
          height: size,
          background:
            "linear-gradient(135deg, #0B1B36 0%, #122B55 55%, #D4A843 130%)",
          color: "#fff",
          fontFamily: '"Outfit", "Plus Jakarta Sans", sans-serif',
          fontWeight: 800,
          fontSize: Math.round(size * 0.42),
          letterSpacing: "-0.04em",
          boxShadow:
            "0 12px 32px -12px rgba(11,27,54,0.35), inset 0 1px 0 rgba(255,255,255,0.18)",
        }}
      >
        DY
      </div>
    );
  }

  return (
    <img
      src={dyLogoSrc}
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      onError={() => setFailed(true)}
      data-testid={testID}
      className={`block object-contain select-none ${className}`}
      style={{
        width: size,
        height: size,
        // Subtle premium drop-shadow keeps the logo grounded on white
        // without baking a hard background behind a potentially
        // transparent PNG.
        filter: "drop-shadow(0 6px 16px rgba(11,27,54,0.12))",
      }}
    />
  );
}
