/**
 * DailyDiscoveryFields.jsx — Dashboard Studio › Today's Discovery form.
 *
 * Edits the `daily_discovery` experienceType's config in place. Per-item
 * artwork reuses HeroArtworkPanel.jsx UNCHANGED — the exact same
 * upload/media-library/placement/scale/padding UI Welcome Hero and
 * Promotion already use. No Dashboard-specific upload, no new asset
 * picker, no new R2 pipeline — this is the whole point of the framework.
 */
import { Plus, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import HeroArtworkPanel from "../HeroArtworkPanel";
import { palettes } from "../../eduhub/styles/tokens/designTokens";

const fieldStyle = {
  width: "100%",
  background: "rgba(10,7,18,0.6)",
  border: "1px solid rgba(212,168,67,0.22)",
  borderRadius: 10,
  color: "#F0E6C8",
  padding: "8px 10px",
  fontSize: 12.5,
};

const labelCls = "block text-[11px] font-bold uppercase tracking-wider text-faded mb-1.5";

function makeBlankItem() {
  return {
    id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: "",
    body: "",
    cta: { label: "", href: "" },
    artwork: null,
  };
}

export default function DailyDiscoveryFields({ config, onChange }) {
  const content = config?.content || { title: "", visible: true, items: [] };
  const items = Array.isArray(content.items) ? content.items : [];

  const setContent = (patch) => onChange({ ...config, content: { ...content, ...patch } });
  const setAppearance = (patch) => onChange({ ...config, appearance: { ...(config?.appearance || {}), ...patch } });

  const setItem = (i, patch) => {
    const next = items.map((it, idx) => (idx === i ? { ...it, ...patch } : it));
    setContent({ items: next });
  };
  const addItem = () => setContent({ items: [...items, makeBlankItem()] });
  const removeItem = (i) => setContent({ items: items.filter((_, idx) => idx !== i) });
  const moveItem = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    setContent({ items: next });
  };

  const emptyState = content.emptyState || {};
  const setEmptyState = (patch) => setContent({ emptyState: { ...emptyState, ...patch } });

  return (
    <div data-testid="daily-discovery-fields">
      <label className="block mb-3">
        <span className={labelCls}>Section title (shown above the card)</span>
        <input
          style={fieldStyle}
          value={content.title || ""}
          data-testid="daily-discovery-title"
          onChange={(e) => setContent({ title: e.target.value })}
          placeholder="Today's Discovery"
        />
      </label>

      <label className="flex items-center gap-2 mb-4 text-[12px] text-parchment">
        <input
          type="checkbox"
          checked={content.visible !== false}
          data-testid="daily-discovery-visible"
          onChange={(e) => setContent({ visible: e.target.checked })}
        />
        Visible on the Dashboard
      </label>

      <div className="block mb-4">
        <span className={labelCls}>Accent palette</span>
        {/* RC2 — swatches instead of a blind text dropdown, so the actual
            color is visible while choosing, not just its name. */}
        <div className="flex flex-wrap gap-2" data-testid="daily-discovery-palette">
          {Object.entries(palettes).map(([id, p]) => {
            const active = (config?.appearance?.paletteId || "morningEmerald") === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setAppearance({ paletteId: id })}
                data-testid={`daily-discovery-palette-${id}`}
                title={p.label}
                className="inline-flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[10.5px] font-semibold transition-all"
                style={{
                  background: active ? "rgba(212,168,67,0.16)" : "rgba(20,14,32,0.5)",
                  border: active ? "1px solid rgba(212,168,67,0.6)" : "1px solid rgba(212,168,67,0.18)",
                  color: active ? "#F4E5C1" : "#B8A98E",
                }}
              >
                <span
                  className="w-4 h-4 rounded-full flex-none"
                  style={{ background: p.accent, boxShadow: active ? "0 0 0 2px rgba(20,14,32,0.9), 0 0 0 3px rgba(212,168,67,0.5)" : "none" }}
                />
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-gold/20 p-4 mb-4" style={{ background: "rgba(20,14,32,0.5)" }} data-testid="daily-discovery-empty-state-fields">
        <p className="text-[11px] font-bold uppercase tracking-wider text-gold mb-1">
          Empty state
        </p>
        <p className="text-[11.5px] text-faded mb-3">
          Shown on the Dashboard whenever no item is published yet (or before this config exists at
          all). Leave any field blank to use the generic default copy — never leave students staring
          at nothing.
        </p>

        <label className="block mb-2">
          <span className={labelCls}>Title</span>
          <input style={fieldStyle} value={emptyState.title || ""}
                 data-testid="daily-discovery-emptystate-title"
                 onChange={(e) => setEmptyState({ title: e.target.value })}
                 placeholder="New discoveries coming soon" />
        </label>

        <label className="block mb-2">
          <span className={labelCls}>Subtitle</span>
          <input style={fieldStyle} value={emptyState.subtitle || ""}
                 data-testid="daily-discovery-emptystate-subtitle"
                 onChange={(e) => setEmptyState({ subtitle: e.target.value })}
                 placeholder="Check back soon for today's word, fact, or challenge." />
        </label>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <label className="block">
            <span className={labelCls}>CTA label (optional)</span>
            <input style={fieldStyle} value={emptyState.cta?.label || ""}
                   data-testid="daily-discovery-emptystate-cta-label"
                   onChange={(e) => setEmptyState({ cta: { ...emptyState.cta, label: e.target.value } })}
                   placeholder="Explore the Library" />
          </label>
          <label className="block">
            <span className={labelCls}>CTA link (optional)</span>
            <input style={fieldStyle} value={emptyState.cta?.href || ""}
                   data-testid="daily-discovery-emptystate-cta-href"
                   onChange={(e) => setEmptyState({ cta: { ...emptyState.cta, href: e.target.value } })}
                   placeholder="/library" />
          </label>
        </div>

        <HeroArtworkPanel
          heroArtwork={emptyState.artwork}
          onChange={(next) => setEmptyState({ artwork: next })}
        />
      </div>

      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-gold">
          Discovery items ({items.length})
        </span>
        <button
          type="button"
          onClick={addItem}
          data-testid="daily-discovery-add-item"
          className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/70 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
        >
          <Plus className="h-3.5 w-3.5" /> Add item
        </button>
      </div>

      {items.length === 0 && (
        <p className="text-[12px] text-faded mb-3" data-testid="daily-discovery-empty">
          No items yet — the Dashboard shows the Empty state above until at least one item exists
          and this config is published.
        </p>
      )}

      <div className="space-y-3">
        {items.map((item, i) => (
          <div
            key={item.id}
            className="rounded-xl border border-gold/20 p-4"
            style={{ background: "rgba(20,14,32,0.5)" }}
            data-testid={`daily-discovery-item-${i}`}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-faded">Item {i + 1}</span>
              <div className="flex-1" />
              <button type="button" onClick={() => moveItem(i, -1)} disabled={i === 0}
                      data-testid={`daily-discovery-item-up-${i}`}
                      className="text-faded hover:text-gold disabled:opacity-30" title="Move up">
                <ChevronUp className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => moveItem(i, 1)} disabled={i === items.length - 1}
                      data-testid={`daily-discovery-item-down-${i}`}
                      className="text-faded hover:text-gold disabled:opacity-30" title="Move down">
                <ChevronDown className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => removeItem(i)}
                      data-testid={`daily-discovery-item-remove-${i}`}
                      className="text-red-300/70 hover:text-red-300" title="Remove item">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            <label className="block mb-2">
              <span className={labelCls}>Title</span>
              <input style={fieldStyle} value={item.title || ""}
                     data-testid={`daily-discovery-item-title-${i}`}
                     onChange={(e) => setItem(i, { title: e.target.value })}
                     placeholder="Curiosity" />
            </label>

            <label className="block mb-2">
              <span className={labelCls}>Body</span>
              <input style={fieldStyle} value={item.body || ""}
                     data-testid={`daily-discovery-item-body-${i}`}
                     onChange={(e) => setItem(i, { body: e.target.value })}
                     placeholder="Learn something new!" />
            </label>

            <div className="grid grid-cols-2 gap-2 mb-2">
              <label className="block">
                <span className={labelCls}>CTA label (optional)</span>
                <input style={fieldStyle} value={item.cta?.label || ""}
                       data-testid={`daily-discovery-item-cta-label-${i}`}
                       onChange={(e) => setItem(i, { cta: { ...item.cta, label: e.target.value } })}
                       placeholder="Discover Now" />
              </label>
              <label className="block">
                <span className={labelCls}>CTA link (optional)</span>
                <input style={fieldStyle} value={item.cta?.href || ""}
                       data-testid={`daily-discovery-item-cta-href-${i}`}
                       onChange={(e) => setItem(i, { cta: { ...item.cta, href: e.target.value } })}
                       placeholder="/library" />
              </label>
            </div>

            <HeroArtworkPanel
              heroArtwork={item.artwork}
              onChange={(next) => setItem(i, { artwork: next })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
