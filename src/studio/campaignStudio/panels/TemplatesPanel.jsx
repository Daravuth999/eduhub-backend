/**
 * TemplatesPanel.jsx — one-click campaign templates + insert menus for
 * text styles, marketing components and effects.
 */
import { useState } from "react";
import { LayoutTemplate, Type as TypeIcon, BadgePercent, Sparkles as SparklesIcon } from "lucide-react";
import { CAMPAIGN_TEMPLATES } from "../templates";
import { TYPOGRAPHY_STYLES } from "../../../eduhub/lib/campaignCanvas/typographyStyles";
import { MARKETING_COMPONENTS } from "../../../eduhub/components/campaign/MarketingComponents";
import { EFFECT_TYPES } from "../../../eduhub/lib/campaignCanvas/canvasSchema";
import { insertText, insertComponent, insertEffect } from "../editorState";
import CampaignCanvasRenderer from "../../../eduhub/components/campaign/CampaignCanvasRenderer";

export default function TemplatesPanel({ dispatch, onApplyTemplate }) {
  const [confirmId, setConfirmId] = useState(null);

  return (
    <div className="flex flex-col gap-4" data-testid="templates-panel">
      <div>
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-faded mb-2">
          <LayoutTemplate className="h-3 w-3" /> Campaign templates
        </p>
        <div className="grid grid-cols-1 gap-2">
          {CAMPAIGN_TEMPLATES.map((t) => (
            <div key={t.id} className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(212,168,67,0.2)" }}>
              {/* role=button div, NOT <button>: template previews render the
                  real canvas, which can contain a CTA <button> layer — and
                  <button> may not nest inside <button> (invalid DOM). */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => setConfirmId(confirmId === t.id ? null : t.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setConfirmId(confirmId === t.id ? null : t.id); } }}
                className="w-full text-left cursor-pointer"
                data-testid={`templates-gallery-template-${t.id}`}
              >
                <div className="pointer-events-none">
                  <CampaignCanvasRenderer canvas={t.build()} appTheme="dark" animateEnabled={false} editMode />
                </div>
                <div className="flex items-center justify-between px-2.5 py-2" style={{ background: "rgba(45,31,62,0.5)" }}>
                  <div>
                    <p className="text-[11.5px] font-bold text-parchment">{t.label}</p>
                    <p className="text-[9.5px] text-faded">{t.hint}</p>
                  </div>
                </div>
              </div>
              {confirmId === t.id && (
                <div className="flex items-center gap-2 px-2.5 py-2" style={{ background: "rgba(20,14,32,0.85)", borderTop: "1px solid rgba(212,168,67,0.2)" }}>
                  <p className="flex-1 text-[10px] text-faded">Replace the current canvas?</p>
                  <button type="button" data-testid={`templates-apply-${t.id}`}
                          onClick={() => { onApplyTemplate(t); setConfirmId(null); }}
                          className="rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider"
                          style={{ background: "linear-gradient(135deg,#FFE19A,#D4A843)", color: "#1a1420" }}>
                    Apply
                  </button>
                  <button type="button" onClick={() => setConfirmId(null)}
                          className="rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-parchment"
                          style={{ background: "rgba(45,31,62,0.8)", border: "1px solid rgba(212,168,67,0.25)" }}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-faded mb-2">
          <TypeIcon className="h-3 w-3" /> Add typography
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {Object.values(TYPOGRAPHY_STYLES).map((s) => (
            <button key={s.id} type="button"
                    onClick={() => insertText(dispatch, { styleId: s.id, text: s.sample, size: s.id === "minimal" ? 2.4 : 6 })}
                    data-testid={`add-text-${s.id}`}
                    className="rounded-xl px-2.5 py-2 text-left transition-colors hover:border-gold"
                    style={{ background: "rgba(45,31,62,0.5)", border: "1px solid rgba(212,168,67,0.18)" }}>
              <p className="text-[11px] font-bold text-parchment truncate">{s.label}</p>
              <p className="text-[9px] text-faded truncate">{s.hint}</p>
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-faded mb-2">
          <BadgePercent className="h-3 w-3" /> Marketing components
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {Object.values(MARKETING_COMPONENTS).map((c) => (
            <button key={c.id} type="button"
                    onClick={() => insertComponent(dispatch, c.id, { ...c.defaults, ...(c.id === "countdown" ? { endsAt: new Date(Date.now() + 7 * 86400000).toISOString() } : null) })}
                    data-testid={`add-component-${c.id}`}
                    className="rounded-xl px-2.5 py-2 text-left transition-colors hover:border-gold"
                    style={{ background: "rgba(45,31,62,0.5)", border: "1px solid rgba(212,168,67,0.18)" }}>
              <p className="text-[11px] font-bold text-parchment truncate">{c.label}</p>
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-faded mb-2">
          <SparklesIcon className="h-3 w-3" /> Ambient effects
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {EFFECT_TYPES.map((f) => (
            <button key={f.id} type="button" onClick={() => insertEffect(dispatch, f.id)}
                    data-testid={`add-effect-${f.id}`}
                    className="rounded-xl px-2.5 py-2 text-left transition-colors hover:border-gold"
                    style={{ background: "rgba(45,31,62,0.5)", border: "1px solid rgba(212,168,67,0.18)" }}>
              <p className="text-[11px] font-bold text-parchment truncate">{f.label}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
