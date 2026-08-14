/**
 * ArtworkDefaultHero.jsx — visual-only fallback for the Dashboard Hero.
 *
 * Shown ONLY when there are no live `dashboard_hero` campaigns, so the area
 * the greeting card used to occupy never renders blank. Purely decorative:
 *   • no API calls / no data dependency
 *   • no Top-Up / payment / AI-tutor / business logic
 *   • not clickable, no actions
 *
 * Reuses the same artwork.css frame styling so it feels native to the system.
 */
import { Sparkles } from "lucide-react";
import "./artwork.css";

export default function ArtworkDefaultHero() {
  return (
    <div
      className="artwork-frame"
      data-clickable="false"
      data-testid="artwork-default-hero"
      aria-label="Welcome to EduHub"
      style={{
        aspectRatio: "21 / 9",
        cursor: "default",
        background:
          "radial-gradient(120% 140% at 18% 0%, #3a2a5e 0%, #2D1F3E 42%, #15101f 100%)",
        border: "1px solid rgba(212,168,67,0.22)",
      }}
    >
      <div className="artwork-anim-float" aria-hidden style={{
        position: "absolute", right: "-6%", top: "-18%",
        width: "44%", height: "120%", borderRadius: "50%",
        background: "radial-gradient(circle, rgba(212,168,67,0.20), rgba(212,168,67,0) 70%)",
        pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", inset: 0, display: "flex", flexDirection: "column",
        justifyContent: "center", gap: 8, padding: "clamp(16px, 4vw, 36px)",
      }}>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 8, alignSelf: "flex-start",
          padding: "5px 12px", borderRadius: 999, fontSize: 11, fontWeight: 800,
          letterSpacing: "0.18em", textTransform: "uppercase", color: "#1a1420",
          background: "linear-gradient(135deg,#FFE19A,#D4A843)",
        }}>
          <Sparkles className="h-3.5 w-3.5" /> EduHub
        </span>
        <h2 style={{
          margin: 0, color: "#F8EFD9", fontWeight: 800, lineHeight: 1.12,
          fontSize: "clamp(18px, 3.6vw, 30px)", maxWidth: "70%",
          textShadow: "0 2px 14px rgba(0,0,0,0.55)",
        }}>
          Welcome back to your learning space
        </h2>
        <p style={{
          margin: 0, color: "rgba(244,229,193,0.78)", fontWeight: 500,
          fontSize: "clamp(12px, 1.9vw, 15px)", maxWidth: "62%",
        }}>
          Read, practice, and earn — one lesson at a time.
        </p>
      </div>
    </div>
  );
}
