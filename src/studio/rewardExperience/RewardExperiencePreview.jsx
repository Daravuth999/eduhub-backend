/**
 * RewardExperiencePreview.jsx — Author Studio live preview canvas.
 * Renders the REAL RewardExperienceShell (contained mode) around a mock
 * popup card, with device frames and optional decoration editing
 * (drag to move; sliders in the inspector handle resize/rotate/etc.).
 * The production popup component is never imported here — logic stays
 * isolated in the student app.
 */
import { useMemo, useRef, useState } from "react";
import RewardExperienceShell from "../../eduhub/components/rewardExperience/RewardExperienceShell";
import { normalizeExperience } from "../../eduhub/components/rewardExperience/experienceThemes";

export const PREVIEW_DEVICES = {
  iphone: { label: "iPhone", w: 300, h: 620 },
  android: { label: "Android", w: 300, h: 600 },
  tablet: { label: "Tablet", w: 460, h: 350 },
  desktop: { label: "Desktop", w: 560, h: 320 },
  mobile: { label: "Mobile", w: 300, h: 540 },
};
export const DEVICE_ORDER = ["iphone", "android", "tablet", "desktop"];

function MockGift({ accent }) {
  return (
    <svg viewBox="0 0 120 120" width="86" height="86" aria-hidden="true">
      <circle cx="60" cy="60" r="44" fill={accent} opacity="0.3" />
      <path d="M40 56h40v30H40z" fill="#fff" stroke="#1a1420" strokeWidth="2" />
      <path d="M36 48h48v10H36z" fill={accent} stroke="#1a1420" strokeWidth="2" />
      <path d="M60 48v38" stroke="#1a1420" strokeWidth="2" />
      <path d="M48 48c-6-10 6-16 12-6 6-10 18-4 12 6" fill="none" stroke="#1a1420" strokeWidth="2" />
    </svg>
  );
}

function MockPopupCard({ form, phase, scale = 1 }) {
  const accent = form.accent_color || "#D4A843";
  const kind = form.reward_kind || "points";
  const hasVoucher = kind === "voucher" || kind === "points_voucher";
  return (
    <div className="rxp-veil-target rxpp-overlay">
      <div style={{ width: "100%", display: "flex", justifyContent: "center", transform: scale !== 1 ? `scale(${scale})` : undefined }}>
      <div className="lrp-card rxpp-card">
        <div className="lrp-hero rxpp-hero">
          {form.artwork_url ? (
            <img
              src={form.artwork_url}
              alt=""
              className="rxpp-artwork"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
          ) : (
            <MockGift accent={accent} />
          )}
        </div>
        <div className="rxpp-body text-center">
          <span className="lrp-badge rxpp-badge" style={{ background: accent, color: "#1a1420" }}>Login Reward</span>
          <div className="lrp-title rxpp-title">{phase === "success" ? "🎉 You got it!" : (form.title || "Welcome back!")}</div>
          <div className="lrp-subtitle rxpp-subtitle">{phase === "success" ? (form.success_message || "Your reward has been credited!") : (form.subtitle || "")}</div>
          {kind !== "voucher" && (
            <div className="lrp-points-wrap rxpp-points" style={{ color: accent }}>
              +{Number(form.reward_points) || 0} <span className="rxpp-pts">PTS</span>
            </div>
          )}
          {hasVoucher && (
            <div
              data-testid="lrp-voucher-teaser"
              className="rxpp-voucher"
              style={{ background: `linear-gradient(135deg, ${form.voucher_accent_color || accent}, #1a1420)` }}
            >
              <div className="rxpp-voucher-kicker">{kind === "points_voucher" ? "+ Book Voucher" : "Book Voucher"}</div>
              <div className="rxpp-voucher-value">
                {form.voucher_discount_label ||
                  (form.voucher_discount_type === "fixed"
                    ? `${Number(form.voucher_discount_value) || 0} pts off`
                    : `${Number(form.voucher_discount_value) || 0}% off`)}
              </div>
            </div>
          )}
          {form.countdown_enabled && form.countdown_mode !== "none" && (
            <div className="lrp-countdown rxpp-countdown">
              {form.countdown_label || "Claim before it expires"}
              <span className="lrp-countdown-clock rxpp-clock">04:59</span>
            </div>
          )}
          <button type="button" className="lrp-claim-btn rxpp-claim" style={{ background: accent, color: "#1a1420" }}>
            {form.cta_text || "Claim Reward"}
          </button>
          <div className="lrp-maybe-later rxpp-later">Maybe later</div>
        </div>
      </div>
      </div>
    </div>
  );
}

const SNAP = 1.6; // % proximity for smart snapping

export default function RewardExperiencePreview({
  form,
  device = "iphone",
  phase = "idle",
  replayKey = 0,
  editable = false,
  selectedIds = [],
  onSelect,
  onUpdateDecoration,
  onUpdateMany,
}) {
  const exp = useMemo(() => normalizeExperience(form.experience), [form.experience]);
  const dev = PREVIEW_DEVICES[device] || PREVIEW_DEVICES.iphone;
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const [guides, setGuides] = useState({ v: null, h: null });

  const selection = useMemo(() => new Set(selectedIds || []), [selectedIds]);
  const byId = (id) => exp.decorations.find((d) => d.id === id);

  const expandWithGroups = (ids) => {
    const groups = new Set(
      exp.decorations.filter((x) => ids.includes(x.id) && x.group).map((x) => x.group),
    );
    const out = new Set(ids);
    exp.decorations.forEach((x) => { if (x.group && groups.has(x.group)) out.add(x.id); });
    return [...out];
  };

  const selectItem = (d, shift) => {
    if (!onSelect) return;
    const groupIds = expandWithGroups([d.id]);
    if (shift) {
      const next = new Set(selection);
      const on = next.has(d.id);
      groupIds.forEach((id) => (on ? next.delete(id) : next.add(id)));
      onSelect([...next]);
    } else if (!selection.has(d.id)) {
      onSelect(groupIds);
    }
  };

  const startMove = (e, d) => {
    selectItem(d, e.shiftKey);
    if (d.locked) return;
    const ids = expandWithGroups(selection.has(d.id) ? [...selection, d.id] : [d.id])
      .filter((id) => { const x = byId(id); return x && !x.locked; });
    const orig = {};
    ids.forEach((id) => { const x = byId(id); orig[id] = { x: x.x, y: x.y }; });
    dragRef.current = { mode: "move", primary: d.id, ids, sx: e.clientX, sy: e.clientY, orig };
  };

  const startResize = (e, d) => {
    e.stopPropagation();
    dragRef.current = { mode: "resize", primary: d.id, sx: e.clientX, sy: e.clientY, size0: d.size };
  };

  const startRotate = (e, d) => {
    e.stopPropagation();
    dragRef.current = { mode: "rotate", primary: d.id };
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!drag || !rect) return;

    if (drag.mode === "move") {
      let dx = ((e.clientX - drag.sx) / rect.width) * 100;
      let dy = ((e.clientY - drag.sy) / rect.height) * 100;
      // smart snapping against stage centre + other items (primary item drives)
      const p0 = drag.orig[drag.primary];
      if (p0) {
        const cand = { x: p0.x + dx, y: p0.y + dy };
        const targetsX = [50, ...exp.decorations.filter((x) => !drag.ids.includes(x.id)).map((x) => x.x)];
        const targetsY = [50, ...exp.decorations.filter((x) => !drag.ids.includes(x.id)).map((x) => x.y)];
        let g = { v: null, h: null };
        for (const t of targetsX) if (Math.abs(cand.x - t) < SNAP) { dx += t - cand.x; g.v = t; break; }
        for (const t of targetsY) if (Math.abs(cand.y - t) < SNAP) { dy += t - cand.y; g.h = t; break; }
        setGuides(g);
      }
      const patch = {};
      drag.ids.forEach((id) => {
        const o = drag.orig[id];
        if (!o) return;
        patch[id] = {
          x: Math.round(Math.min(100, Math.max(0, o.x + dx)) * 10) / 10,
          y: Math.round(Math.min(100, Math.max(0, o.y + dy)) * 10) / 10,
        };
      });
      if (onUpdateMany) onUpdateMany(patch);
      else if (onUpdateDecoration) Object.entries(patch).forEach(([id, p]) => onUpdateDecoration(id, p));
    } else if (drag.mode === "resize") {
      const delta = (e.clientX - drag.sx) + (e.clientY - drag.sy);
      const size = Math.round(Math.min(400, Math.max(16, drag.size0 + delta)));
      onUpdateDecoration && onUpdateDecoration(drag.primary, { size });
    } else if (drag.mode === "rotate") {
      const d = byId(drag.primary);
      if (!d) return;
      const cx = rect.left + (d.x / 100) * rect.width;
      const cy = rect.top + (d.y / 100) * rect.height;
      let ang = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90;
      if (ang > 180) ang -= 360;
      const snapAng = Math.round(ang / 15) * 15;
      if (Math.abs(ang - snapAng) < 4) ang = snapAng;
      onUpdateDecoration && onUpdateDecoration(drag.primary, { rotation: Math.round(ang) });
    }
  };

  const endDrag = () => { dragRef.current = null; setGuides({ v: null, h: null }); };

  return (
    <div
      ref={stageRef}
      data-testid="rxp-preview-stage"
      className="relative mx-auto rounded-2xl overflow-hidden border border-white/10 bg-black"
      style={{ width: "100%", maxWidth: dev.w, aspectRatio: `${dev.w} / ${dev.h}` }}
      onClick={(e) => { if (e.target === e.currentTarget && onSelect) onSelect([]); }}
    >
      <RewardExperienceShell
        key={replayKey}
        experience={exp}
        accent={form.accent_color || "#D4A843"}
        phase={phase}
        contained
      >
        <MockPopupCard form={form} phase={phase} scale={dev.h < 400 ? Math.max(0.55, dev.h / 560) : 1} />
      </RewardExperienceShell>

      {editable && (
        <>
          {/* safe zone (card area) */}
          <div className="rxpp-safezone" aria-hidden="true" />
          {/* alignment guides */}
          {guides.v != null && <div className="rxpp-guide" style={{ left: `${guides.v}%`, top: 0, bottom: 0, width: 1 }} />}
          {guides.h != null && <div className="rxpp-guide" style={{ top: `${guides.h}%`, left: 0, right: 0, height: 1 }} />}
          {/* manipulation handles above everything */}
          <div
            className="absolute inset-0"
            style={{ zIndex: 8 }}
            onClick={() => onSelect && onSelect([])}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
          >
            {exp.decorations.filter((d) => d.visible !== false).map((d) => {
              const isSel = selection.has(d.id);
              return (
                <div
                  key={d.id}
                  data-testid={`rxp-handle-${d.id}`}
                  onPointerDown={(e) => {
                    e.stopPropagation(); e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    startMove(e, d);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute"
                  style={{
                    left: `${d.x}%`, top: `${d.y}%`,
                    width: d.size, height: d.size,
                    transform: "translate(-50%,-50%)",
                    cursor: d.locked ? "not-allowed" : "move",
                    border: isSel ? "1.5px dashed #FFE19A" : "1.5px dashed transparent",
                    borderRadius: 8,
                    touchAction: "none",
                  }}
                >
                  {isSel && !d.locked && (
                    <>
                      <span
                        data-testid={`rxp-rotate-${d.id}`}
                        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); startRotate(e, d); }}
                        className="rxpp-knob"
                        style={{ left: "50%", top: -18, transform: "translateX(-50%)", cursor: "grab", borderRadius: "50%" }}
                      />
                      <span
                        data-testid={`rxp-resize-${d.id}`}
                        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); startResize(e, d); }}
                        className="rxpp-knob"
                        style={{ right: -6, bottom: -6, cursor: "nwse-resize", borderRadius: 3 }}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <style>{`
        .rxpp-overlay { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; background: rgba(8,5,15,0.62); }
        .rxpp-card { position: relative; width: 74%; max-width: 250px; border-radius: 22px; overflow: hidden; text-align: center;
          background: linear-gradient(180deg, #fff8ec 0%, #ffe9c7 100%); color: #1a1420; box-shadow: 0 18px 40px -10px rgba(0,0,0,0.5); }
        .rxpp-hero { display: flex; align-items: center; justify-content: center; padding: 14px 0 0; }
        .rxpp-artwork { height: 86px; width: auto; object-fit: contain; filter: drop-shadow(0 8px 14px rgba(0,0,0,0.25)); }
        .rxpp-body { padding: 4px 14px 16px; }
        .rxpp-badge { display: inline-block; font-size: 8.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; border-radius: 9999px; padding: 2px 8px; }
        .rxpp-title { font-size: 15px; font-weight: 900; margin-top: 6px; line-height: 1.15; }
        .rxpp-subtitle { font-size: 10px; color: #5b4632; margin-top: 3px; line-height: 1.35; }
        .rxpp-points { margin-top: 8px; font-size: 24px; font-weight: 900; }
        .rxpp-pts { font-size: 12px; font-weight: 800; }
        .rxpp-voucher { margin-top: 8px; border-radius: 12px; padding: 8px 10px; color: #fff; text-align: left; }
        .rxpp-voucher-kicker { font-size: 8px; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.85; }
        .rxpp-voucher-value { font-size: 14px; font-weight: 900; }
        .rxpp-countdown { margin-top: 10px; display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 9999px;
          background: rgba(0,0,0,0.06); border: 1px solid rgba(0,0,0,0.1); font-size: 8.5px; font-weight: 700; color: #4a2f10; }
        .rxpp-clock { font-family: ui-monospace, monospace; font-size: 9px; background: rgba(255,255,255,0.7); border-radius: 5px; padding: 1px 5px; }
        .rxpp-claim { display: block; margin: 10px auto 0; width: 100%; border: none; border-radius: 9999px; padding: 8px 12px;
          font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; cursor: default; }
        .rxpp-later { margin-top: 6px; font-size: 8.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #5b4632; }
        .rxpp-safezone { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 74%; max-width: 250px; height: 78%;
          border: 1px dashed rgba(255,225,154,0.35); border-radius: 22px; z-index: 7; pointer-events: none; }
        .rxpp-guide { position: absolute; background: #5EE0FF; z-index: 9; pointer-events: none; box-shadow: 0 0 6px #5EE0FF; }
        .rxpp-knob { position: absolute; width: 12px; height: 12px; background: #FFE19A; border: 1.5px solid #1a1420; z-index: 10; touch-action: none; }
      `}</style>
    </div>
  );
}
