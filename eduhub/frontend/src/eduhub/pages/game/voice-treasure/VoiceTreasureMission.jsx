import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, ShieldCheck, BookOpen, Eye } from "lucide-react";
import * as api from "./api";
import { resolveBundledImage } from "./sceneAssets";
import { useVoiceTreasureTitle, VoiceTreasureIdentity } from "./useVoiceTreasureIdentity";
import VTStage from "./VTStage";
import "./VoiceTreasure.css";

/**
 * Pass B.2 — Mission visual reconstruction.
 *
 * Sits on top of VTStage (shared layered backdrop). Renders the EXACT
 * mission image assigned by the backend — never substitutes a different
 * scene. Generated missions use the authenticated `image_url`; bundled
 * missions use the CRA-fingerprinted bundled WebP.
 *
 * Bilingual instruction hierarchy:
 *   1. primary instruction (English or bilingual primary)
 *   2. secondary instruction (Khmer, if the backend returned one)
 *   3. response-language pill (English / Khmer / bilingual)
 *   4. difficulty pill
 *   5. paid-entry pill
 *
 * The Start-Recording CTA is disabled until the mission image is
 * confirmed visible — preventing a student from speaking against an
 * image they never saw. A safe recover path is offered when the image
 * cannot load.
 */
export default function VoiceTreasureMission() {
  useVoiceTreasureTitle("Today's Mission");
  const nav = useNavigate();
  const [mission, setMission] = useState(null);
  const [language, setLanguage] = useState(null);
  const [entryId, setEntryId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [recovering, setRecovering] = useState(false);

  const loadMission = async () => {
    setImgError(false);
    setImgLoaded(false);
    const t = await api.getToday();
    if (!t.available) { setError("unavailable"); return; }
    if (!t.existing_entry?.paid) { nav("/game/voice-treasure/confirm"); return; }
    setEntryId(t.existing_entry.entry_id);
    setLanguage(t.language || null);
    const img = await api.getMissionImage(t.mission.mission_id);
    setMission({ ...t.mission, ...img });
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await loadMission(); }
      catch (e) { if (alive) setError(e?.message || "Could not load mission."); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav]);

  if (loading) {
    return (
      <VTStage>
        <VoiceTreasureIdentity subtitle="Today's Mission" />
        <div className="vt-dim" data-testid="vt-mission-loading">Loading mission…</div>
      </VTStage>
    );
  }
  if (error === "unavailable") {
    return (
      <VTStage>
        <VoiceTreasureIdentity subtitle="Today's Mission" />
        <div className="vt-panel" data-testid="vt-mission-unavailable">Voice Treasure isn't available right now.</div>
      </VTStage>
    );
  }
  if (error) {
    return (
      <VTStage>
        <VoiceTreasureIdentity subtitle="Today's Mission" />
        <div className="vt-error" data-testid="vt-mission-error">{error}</div>
      </VTStage>
    );
  }

  const kind = mission?.image_kind;
  const bundled = resolveBundledImage({ imageRef: mission?.image_ref, sceneId: mission?.scene_id });
  // Generated missions deliver the authenticated content URL verbatim.
  const generatedUrl = kind === "generated"
    ? (mission?.image_url
        ? (mission.image_url.startsWith("http")
            ? mission.image_url
            : `${(process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "")}${mission.image_url}`)
        : null)
    : null;
  const imgSrc = kind === "generated" ? generatedUrl : bundled;
  const title = mission?.title || "Look closely";

  // Bilingual instruction text — backend is authoritative.
  const instruction = language?.instruction;
  const promptPrimary = instruction?.primary
    || mission?.prompt
    || "Study the picture, then describe what you see in your own words.";
  const promptSecondary = instruction?.secondary || "";
  const promptLang = instruction?.lang === "km" ? "km" : undefined;
  const responseLabel = language?.accepted_response_label || "English";
  const alt = mission?.alt || "Today's mission picture";
  const safeToSubmit = !!imgSrc && imgLoaded && !imgError;

  const onImageLoad = () => setImgLoaded(true);
  const onImageError = () => { setImgError(true); setImgLoaded(false); };
  const onRecover = async () => {
    setRecovering(true);
    try { await loadMission(); } catch { /* leave state */ }
    finally { setRecovering(false); }
  };

  return (
    <VTStage sceneImage={imgSrc} sceneAlt={alt}>
      <VoiceTreasureIdentity subtitle="Today's Mission" />

      <div className="vt-panel vt-card-glow vt-mission-panel" data-testid="vt-mission" data-image-kind={kind || "fallback"}>
        {/* Mission scene framed inside the content card too — the VTStage
            scene layer is decorative; this in-card frame is the
            evaluation-truth surface so the student sees it identical to
            what Gemini receives. */}
        <div className="vt-mission-frame vt-mission-frame--hero" data-testid="vt-mission-image">
          {imgSrc && !imgError && (
            <img
              className="vt-mission-img"
              src={imgSrc}
              alt={alt}
              draggable="false"
              loading="eager"
              onLoad={onImageLoad}
              onError={onImageError}
              data-testid={kind === "generated" ? "vt-mission-img-generated" : "vt-mission-img-bundled"}
            />
          )}
          {(!imgSrc || imgError) && (
            <div className="vt-error" data-testid="vt-mission-img-error">
              We couldn't load this mission's image. Please recover to continue —
              you have not been charged again.
            </div>
          )}
          <div className="vt-mission-frame-watch" aria-hidden="true">
            <Eye size={12} />
            <span>Look closely</span>
          </div>
        </div>

        <div className="vt-h1 vt-mission-title" data-testid="vt-mission-title">{title}</div>

        <div className="vt-mission-meta" data-testid="vt-mission-language">
          <span className="vt-pill vt-pill-paid" data-testid="vt-mission-paid">
            <ShieldCheck size={12} aria-hidden="true" /> Entry paid
          </span>
          {mission?.difficulty ? (
            <span className="vt-pill" data-testid="vt-mission-difficulty">{mission.difficulty}</span>
          ) : null}
          <span className="vt-pill" data-testid="vt-mission-language-pill">
            <BookOpen size={12} aria-hidden="true" />
            <span className="vt-dim" style={{ marginLeft: 4 }}>Respond in</span>{" "}
            <span data-testid="vt-mission-language-label" style={{ fontWeight: 700 }}>{responseLabel}</span>
          </span>
        </div>

        <div className="vt-mission-instructions" data-testid="vt-mission-instructions">
          <p className="vt-mission-prompt" data-testid="vt-mission-prompt" lang={promptLang}>
            {promptPrimary}
          </p>
          {promptSecondary ? (
            <p className="vt-mission-prompt vt-mission-prompt--km" data-testid="vt-mission-prompt-secondary" lang="km">
              {promptSecondary}
            </p>
          ) : null}
          <ul className="vt-mission-tips" data-testid="vt-mission-tips" aria-label="Speaking tips">
            <li>Take a slow breath, then start your sentence.</li>
            <li>Name what you see; add one detail about colour, action, or feeling.</li>
            <li>Speak for 10–30 seconds. Stop when you've said enough.</li>
          </ul>
        </div>

        {(!imgSrc || imgError) && (
          <button
            className="vt-btn vt-btn-ghost"
            data-testid="vt-mission-recover"
            onClick={onRecover}
            disabled={recovering}
            style={{ marginTop: 10 }}
          >
            {recovering ? "Recovering…" : "Try again"}
          </button>
        )}

        <button
          className="vt-btn vt-btn-gold vt-btn-cta"
          data-testid="vt-to-record"
          style={{ marginTop: 14, display: "inline-flex", alignItems: "center", gap: 8 }}
          disabled={!safeToSubmit}
          title={safeToSubmit ? "" : "Image must load before recording"}
          onClick={() => nav("/game/voice-treasure/record", {
            state: { entryId, prompt: promptPrimary, missionId: mission?.mission_id, imgSrc, imgAlt: alt, imageKind: kind },
          })}
        >
          <Mic size={16} aria-hidden="true" />
          Start Recording
        </button>
      </div>
    </VTStage>
  );
}
