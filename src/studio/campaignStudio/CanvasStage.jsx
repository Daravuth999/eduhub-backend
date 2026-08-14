/**
 * CanvasStage.jsx — the interactive design surface of Campaign Design
 * Studio 2.0. The canvas IS the editor: authors select, drag, resize and
 * rotate layers directly on a live render of the REAL CampaignCanvasRenderer
 * (the same engine the student Dashboard uses).
 *
 * Interaction model (pointer events, rAF-free — React state updates are
 * cheap at this scale; no scroll listeners per the performance directive):
 *   • click layer          -> select
 *   • drag body            -> move (snap guides: canvas center + safe area)
 *   • drag corner handle   -> resize (images keep aspect; text scales font)
 *   • drag rotate handle   -> rotate (snaps to 0/±15/±30/±45/90 within 4°)
 *   • click empty stage    -> select background layer
 *   • arrow keys           -> nudge (+shift = 5x)
 *   • Delete/Backspace     -> remove layer
 *
 * A continuous gesture dispatches CHECKPOINT once on pointer-down, then
 * TRANSIENT_LAYER frames — one undo step per gesture.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import CampaignCanvasRenderer from "../../eduhub/components/campaign/CampaignCanvasRenderer";
import { frameToStyle } from "../../eduhub/lib/campaignCanvas/canvasSchema";

const SNAP_THRESHOLD = 1.1; // percent
const ROTATE_SNAPS = [0, 15, 30, 45, 60, 90, -15, -30, -45, -60, -90, 180];

const FRAMED_TYPES = new Set(["image", "text", "component"]);

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export default function CanvasStage({
  state, dispatch, appTheme, stageWidth, showSafeArea, motionPreviewKey,
}) {
  const { canvas, selectedId } = state;
  const stageRef = useRef(null);
  const gestureRef = useRef(null);
  const [guides, setGuides] = useState({ v: null, h: null });

  const selected = canvas.layers.find((l) => l.id === selectedId) || null;
  const selectedFramed = selected && FRAMED_TYPES.has(selected.type) && selected.role !== "poster";

  /* ────── pointer gesture engine ────── */
  const beginGesture = useCallback((e, mode, layer, corner) => {
    if (!stageRef.current || layer.locked) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = stageRef.current.getBoundingClientRect();
    dispatch({ type: "CHECKPOINT" });
    dispatch({ type: "SELECT", id: layer.id });
    const centerPx = {
      x: rect.left + (layer.frame.x / 100) * rect.width,
      y: rect.top + (layer.frame.y / 100) * rect.height,
    };
    gestureRef.current = {
      mode, corner,
      layerId: layer.id,
      startX: e.clientX, startY: e.clientY,
      rect,
      startFrame: { ...layer.frame },
      startRotation: layer.rotation || 0,
      startSize: layer.size || null,
      startAngle: Math.atan2(e.clientY - centerPx.y, e.clientX - centerPx.x) * (180 / Math.PI),
      centerPx,
      type: layer.type,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
  }, [dispatch]);

  const onPointerMove = useCallback((e) => {
    const g = gestureRef.current;
    if (!g) return;
    const { rect } = g;
    const dxPct = ((e.clientX - g.startX) / rect.width) * 100;
    const dyPct = ((e.clientY - g.startY) / rect.height) * 100;

    if (g.mode === "move") {
      let x = g.startFrame.x + dxPct;
      let y = g.startFrame.y + dyPct;
      const sa = canvas.safeArea || { x: 6, y: 10, w: 88, h: 80 };
      const vTargets = [50, sa.x, sa.x + sa.w];
      const hTargets = [50, sa.y, sa.y + sa.h];
      let vGuide = null; let hGuide = null;
      for (const t of vTargets) if (Math.abs(x - t) < SNAP_THRESHOLD) { x = t; vGuide = t; break; }
      for (const t of hTargets) if (Math.abs(y - t) < SNAP_THRESHOLD) { y = t; hGuide = t; break; }
      setGuides({ v: vGuide, h: hGuide });
      dispatch({
        type: "TRANSIENT_LAYER", id: g.layerId,
        patch: { frame: { ...g.startFrame, x: clamp(x, -20, 120), y: clamp(y, -20, 120) } },
      });
      return;
    }

    if (g.mode === "resize") {
      // symmetric center-anchored resize; horizontal delta drives scale
      const sign = g.corner.includes("e") ? 1 : -1;
      const scale = clamp((g.startFrame.w + sign * dxPct * 2) / g.startFrame.w, 0.12, 6);
      const patch = { frame: { ...g.startFrame, w: clamp(g.startFrame.w * scale, 2, 160) } };
      if (Number.isFinite(g.startFrame.h)) patch.frame.h = clamp(g.startFrame.h * scale, 2, 160);
      if (g.type === "text" || g.type === "component") patch.size = clamp((g.startSize || 4) * scale, 0.6, 30);
      dispatch({ type: "TRANSIENT_LAYER", id: g.layerId, patch });
      return;
    }

    if (g.mode === "rotate") {
      const angleNow = Math.atan2(e.clientY - g.centerPx.y, e.clientX - g.centerPx.x) * (180 / Math.PI);
      let rotation = g.startRotation + (angleNow - g.startAngle);
      rotation = ((rotation + 540) % 360) - 180;
      for (const s of ROTATE_SNAPS) if (Math.abs(rotation - s) < 4) { rotation = s; break; }
      dispatch({ type: "TRANSIENT_LAYER", id: g.layerId, patch: { rotation: Math.round(rotation * 10) / 10 } });
    }
  }, [canvas.safeArea, dispatch]);

  const endGesture = useCallback(() => {
    gestureRef.current = null;
    setGuides({ v: null, h: null });
  }, []);

  /* ────── keyboard ────── */
  const onKeyDown = useCallback((e) => {
    if (!selected || selected.type === "background" || selected.locked) return;
    const step = e.shiftKey ? 2.5 : 0.5;
    const move = (dx, dy) => {
      e.preventDefault();
      dispatch({
        type: "UPDATE_LAYER", id: selected.id,
        patch: { frame: { ...selected.frame, x: selected.frame.x + dx, y: selected.frame.y + dy } },
      });
    };
    if (e.key === "ArrowLeft") move(-step, 0);
    else if (e.key === "ArrowRight") move(step, 0);
    else if (e.key === "ArrowUp") move(0, -step);
    else if (e.key === "ArrowDown") move(0, step);
    else if ((e.key === "Delete" || e.key === "Backspace") && !e.target.closest("input,textarea")) {
      e.preventDefault();
      dispatch({ type: "REMOVE_LAYER", id: selected.id });
    }
  }, [selected, dispatch]);

  useEffect(() => {
    const el = stageRef.current?.parentElement;
    if (!el) return undefined;
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  const sa = canvas.safeArea || { x: 6, y: 10, w: 88, h: 80 };

  return (
    <div
      className="relative mx-auto outline-none"
      style={{ width: stageWidth, maxWidth: "100%" }}
      tabIndex={-1}
      data-testid="canvas-stage"
    >
      <div
        ref={stageRef}
        className="relative rounded-2xl overflow-hidden"
        style={{ boxShadow: "0 24px 70px rgba(0,0,0,0.5), 0 0 0 1px rgba(212,168,67,0.22)" }}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        {/* THE live render — the same engine that ships to the Dashboard */}
        <CampaignCanvasRenderer
          key={motionPreviewKey}
          canvas={canvas}
          appTheme={appTheme}
          animateEnabled={Boolean(motionPreviewKey)}
          editMode={!motionPreviewKey}
          interactive={false}
        />

        {/* ── interaction overlay ── */}
        <div
          className="absolute inset-0"
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return;
            const bg = canvas.layers.find((l) => l.type === "background");
            dispatch({ type: "SELECT", id: bg ? bg.id : null });
          }}
          data-testid="canvas-overlay"
        >
          {/* safe area */}
          {showSafeArea && (
            <div
              aria-hidden
              className="absolute pointer-events-none rounded-lg"
              style={{
                left: `${sa.x}%`, top: `${sa.y}%`, width: `${sa.w}%`, height: `${sa.h}%`,
                border: "1px dashed rgba(244,229,193,0.35)",
                background: "rgba(244,229,193,0.02)",
              }}
              data-testid="canvas-safe-area"
            />
          )}

          {/* snap guides */}
          {guides.v !== null && (
            <div aria-hidden className="absolute pointer-events-none" style={{ left: `${guides.v}%`, top: 0, bottom: 0, width: 1, background: "rgba(255,225,154,0.8)" }} />
          )}
          {guides.h !== null && (
            <div aria-hidden className="absolute pointer-events-none" style={{ top: `${guides.h}%`, left: 0, right: 0, height: 1, background: "rgba(255,225,154,0.8)" }} />
          )}

          {/* hit boxes for framed layers (poster/effect/background handled via panel or stage click) */}
          {canvas.layers.map((layer) => {
            if (!FRAMED_TYPES.has(layer.type) || layer.role === "poster" || layer.visible === false) return null;
            const isSel = layer.id === selectedId;
            return (
              <div
                key={layer.id}
                style={{
                  ...frameToStyle(layer.frame, layer.rotation),
                  ...(Number.isFinite(layer.frame?.h) ? null : { height: "12%", minHeight: 34 }),
                  cursor: layer.locked ? "not-allowed" : "move",
                  touchAction: "none",
                }}
                onPointerDown={(e) => beginGesture(e, "move", layer)}
                data-testid={`canvas-hit-${layer.id}`}
              >
                {/* selection chrome */}
                {isSel && (
                  <>
                    <div
                      aria-hidden
                      className="absolute inset-0 pointer-events-none rounded-[4px]"
                      style={{ boxShadow: "0 0 0 1px rgba(212,168,67,0.9), 0 0 0 4px rgba(212,168,67,0.18)" }}
                    />
                    {!layer.locked && ["nw", "ne", "sw", "se"].map((corner) => (
                      <div
                        key={corner}
                        onPointerDown={(e) => beginGesture(e, "resize", layer, corner)}
                        className="absolute rounded-full"
                        style={{
                          width: 12, height: 12,
                          background: "#0d0a16",
                          border: "1.5px solid rgba(255,225,154,0.95)",
                          boxShadow: "0 4px 10px rgba(0,0,0,0.45)",
                          left: corner.includes("w") ? -6 : undefined,
                          right: corner.includes("e") ? -6 : undefined,
                          top: corner.includes("n") ? -6 : undefined,
                          bottom: corner.includes("s") ? -6 : undefined,
                          cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                          touchAction: "none",
                        }}
                        data-testid={`canvas-handle-${corner}`}
                      />
                    ))}
                    {!layer.locked && (
                      <div
                        onPointerDown={(e) => beginGesture(e, "rotate", layer)}
                        className="absolute left-1/2 -translate-x-1/2 grid place-items-center rounded-full"
                        style={{
                          top: -34, width: 22, height: 22,
                          background: "#0d0a16",
                          border: "1.5px solid rgba(255,225,154,0.95)",
                          boxShadow: "0 4px 10px rgba(0,0,0,0.45)",
                          cursor: "grab", touchAction: "none",
                        }}
                        data-testid="canvas-handle-rotate"
                      >
                        <RotateCw className="h-3 w-3 text-gold" />
                        <div aria-hidden className="absolute left-1/2 top-full h-3 w-px bg-[rgba(255,225,154,0.6)]" />
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
