/**
 * HeroArtworkPanel.jsx — Author Studio › Welcome Experience › Hero Artwork.
 *
 * Controls for the transparent composition layer HeroArtworkLayer.jsx
 * renders inside the real Hero (see heroArtworkSchema.js for the shared
 * shape/layout math both this panel and the student-facing Hero rely on —
 * this file only ever WRITES that shape, it never re-derives placement/
 * scale/padding CSS itself).
 *
 * Source, placement, scale, padding, layer order, and overflow are all
 * exposed here per the approved directive. Every change calls onChange
 * with the full next heroArtwork object and a bumped `version` — the
 * live preview (the real Hero component, rendered by the parent) picks
 * it up immediately since it's just a prop, no publish required.
 */
import { useRef, useState } from "react";
import { Upload, Image as ImageIcon, X, Trash2, Check, Loader2 } from "lucide-react";
import { uploadHeroArtwork, listHeroArtworkLibrary, deleteHeroArtworkAsset } from "./api";
import {
  ARTWORK_PLACEMENTS,
  ARTWORK_LAYER_ORDERS,
  getDefaultHeroArtwork,
} from "../eduhub/lib/experienceConfig/heroArtworkSchema";

const fieldStyle = {
  width: "100%",
  background: "rgba(20,14,32,0.7)",
  border: "1px solid rgba(212,168,67,0.25)",
  borderRadius: 12,
  color: "#F4E5C1",
  padding: "8px 10px",
  fontSize: 12.5,
  outline: "none",
};

const labelCls = "block text-[11px] font-bold uppercase tracking-wider text-faded mb-1.5";

function Section({ title, children }) {
  return (
    <div className="mb-4">
      <p className={labelCls}>{title}</p>
      {children}
    </div>
  );
}

const ACCEPT = "image/png,image/webp,image/svg+xml,image/jpeg";

export default function HeroArtworkPanel({ heroArtwork, onChange }) {
  const a = heroArtwork || getDefaultHeroArtwork();
  const [library, setLibrary] = useState(null); // null = not fetched yet
  const [showLibrary, setShowLibrary] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);
  const fileInputRef = useRef(null);

  const hasArtwork = Boolean(a.url);

  // Every real edit bumps version — the artwork's own cache (Phase C) and
  // the Dashboard Bootstrap crossfade key both key off it, per the
  // documented contract in heroArtworkSchema.js.
  const commit = (fields) => onChange({ ...a, ...fields, version: (a.version || 0) + 1 });

  const handleUploadFile = async (file) => {
    if (!file) return;
    setUploading(true);
    setErr(null);
    try {
      const res = await uploadHeroArtwork(file);
      commit({ assetId: res.asset.id, url: res.asset.url });
    } catch (e) {
      setErr(e.message || "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const openLibrary = async () => {
    setShowLibrary(true);
    setErr(null);
    if (library === null) {
      try {
        const res = await listHeroArtworkLibrary();
        setLibrary(res.assets || []);
      } catch (e) {
        setErr(e.message || "Failed to load the media library.");
        setLibrary([]);
      }
    }
  };

  const pickFromLibrary = (asset) => {
    commit({ assetId: asset.id, url: asset.url });
    setShowLibrary(false);
  };

  const handleDeleteAsset = async (id, ev) => {
    ev.stopPropagation();
    try {
      await deleteHeroArtworkAsset(id);
      setLibrary((lib) => (lib || []).filter((x) => x.id !== id));
    } catch (e) {
      setErr(e.message || "Delete failed.");
    }
  };

  const removeArtwork = () => {
    onChange({ ...getDefaultHeroArtwork(), version: (a.version || 0) + 1 });
  };

  return (
    <div data-testid="hero-artwork-panel">
      <p className="text-[11px] font-bold uppercase tracking-wider text-gold mt-5 mb-2">Hero Artwork</p>
      <p className="text-[11px] text-faded mb-3">
        A transparent PNG, WebP, or SVG (JPEG also supported) composited inside the Hero — independent of its background gradient.
      </p>

      {err && (
        <div className="mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[11.5px]"
             style={{ background: "rgba(255,100,100,0.12)", color: "#fca5a5" }} data-testid="hero-artwork-error">
          {err}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          data-testid="hero-artwork-file-input"
          onChange={(e) => handleUploadFile(e.target.files?.[0])}
        />
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          data-testid="hero-artwork-upload"
          className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/70 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold disabled:opacity-50"
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {uploading ? "Uploading…" : hasArtwork ? "Replace" : "Upload"}
        </button>
        <button
          type="button"
          onClick={openLibrary}
          data-testid="hero-artwork-browse-library"
          className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/70 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
        >
          <ImageIcon className="h-3.5 w-3.5" /> Media Library
        </button>
        {hasArtwork && (
          <button
            type="button"
            onClick={removeArtwork}
            data-testid="hero-artwork-remove"
            className="inline-flex items-center gap-1.5 rounded-full border border-red-400/30 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-red-300 hover:border-red-400"
          >
            <X className="h-3.5 w-3.5" /> Remove
          </button>
        )}
      </div>

      {hasArtwork && (
        <div className="mb-4 rounded-xl border border-white/10 p-2 inline-flex" style={{ background: "rgba(0,0,0,0.25)" }} data-testid="hero-artwork-current-preview">
          <img src={a.url} alt="" style={{ maxHeight: 64, maxWidth: 140, objectFit: "contain" }} />
        </div>
      )}

      {showLibrary && (
        <div className="mb-4 rounded-2xl border border-gold/25 p-4" style={{ background: "rgba(15,10,24,0.9)" }} data-testid="hero-artwork-library-modal">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-gold">Media Library</p>
            <button type="button" onClick={() => setShowLibrary(false)} data-testid="hero-artwork-library-close" className="text-faded hover:text-parchment">
              <X className="h-4 w-4" />
            </button>
          </div>
          {library === null ? (
            <p className="text-[12px] text-faded">Loading…</p>
          ) : library.length === 0 ? (
            <p className="text-[12px] text-faded" data-testid="hero-artwork-library-empty">No artwork uploaded yet — use Upload above.</p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5" data-testid="hero-artwork-library-grid">
              {library.map((asset) => (
                <div
                  key={asset.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => pickFromLibrary(asset)}
                  onKeyDown={(e) => { if (e.key === "Enter") pickFromLibrary(asset); }}
                  data-testid={`hero-artwork-library-item-${asset.id}`}
                  className="relative rounded-xl border border-white/10 p-2 cursor-pointer hover:border-gold/50"
                  style={{ background: "rgba(0,0,0,0.3)" }}
                >
                  <img src={asset.url} alt="" style={{ height: 56, width: "100%", objectFit: "contain" }} />
                  <button
                    type="button"
                    onClick={(e) => handleDeleteAsset(asset.id, e)}
                    data-testid={`hero-artwork-library-delete-${asset.id}`}
                    title="Delete from library"
                    className="absolute top-1 right-1 rounded-full p-1 text-red-300/80 hover:text-red-300"
                    style={{ background: "rgba(0,0,0,0.55)" }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {hasArtwork && (
        <>
          <Section title="Placement">
            <div className="flex flex-wrap gap-1.5">
              {ARTWORK_PLACEMENTS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => commit({ placement: p.id })}
                  aria-pressed={a.placement === p.id}
                  data-testid={`hero-artwork-placement-${p.id}`}
                  className="rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider"
                  style={
                    a.placement === p.id
                      ? { background: "rgba(212,168,67,0.28)", color: "#F4E5C1", border: "1px solid rgba(212,168,67,0.6)" }
                      : { background: "rgba(255,255,255,0.04)", color: "rgba(244,229,193,0.6)", border: "1px solid rgba(255,255,255,0.10)" }
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Section>

          {a.placement === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <Section title={`X position · ${a.customX}%`}>
                <input type="range" min="0" max="100" value={a.customX}
                       data-testid="hero-artwork-custom-x"
                       onChange={(e) => commit({ customX: Number(e.target.value) })}
                       className="w-full accent-[#D4A843]" />
              </Section>
              <Section title={`Y position · ${a.customY}%`}>
                <input type="range" min="0" max="100" value={a.customY}
                       data-testid="hero-artwork-custom-y"
                       onChange={(e) => commit({ customY: Number(e.target.value) })}
                       className="w-full accent-[#D4A843]" />
              </Section>
            </div>
          )}

          <Section title={`Scale · ${a.scale}%`}>
            <input type="range" min="40" max="200" value={a.scale}
                   data-testid="hero-artwork-scale"
                   onChange={(e) => commit({ scale: Number(e.target.value) })}
                   className="w-full accent-[#D4A843]" />
          </Section>

          <Section title="Padding (px) — keeps artwork off the Hero's rounded corners">
            <div className="grid grid-cols-4 gap-2">
              {["top", "bottom", "left", "right"].map((edge) => (
                <div key={edge}>
                  <label className="block text-[9.5px] uppercase tracking-wider text-faded mb-1 capitalize">{edge}</label>
                  <input
                    type="number"
                    min="0"
                    max="200"
                    style={fieldStyle}
                    value={a.padding?.[edge] ?? 16}
                    data-testid={`hero-artwork-padding-${edge}`}
                    onChange={(e) => commit({ padding: { ...a.padding, [edge]: Number(e.target.value) || 0 } })}
                  />
                </div>
              ))}
            </div>
          </Section>

          <Section title="Layer order">
            <select
              style={fieldStyle}
              value={a.layerOrder}
              data-testid="hero-artwork-layer-order"
              onChange={(e) => commit({ layerOrder: e.target.value })}
            >
              {ARTWORK_LAYER_ORDERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </Section>

          <button
            type="button"
            onClick={() => commit({ allowOverflow: !a.allowOverflow })}
            data-testid="hero-artwork-allow-overflow"
            className="inline-flex items-center gap-2 text-[12px] font-bold text-parchment"
          >
            {a.allowOverflow ? <Check className="h-4 w-4 text-green-400" /> : <X className="h-4 w-4 text-faded" />}
            Allow overflow beyond Hero bounds
          </button>

          {/* Effects — additive fields on heroArtworkSchema.js (Promotion
              Experience Studio directive). Shared here so Welcome Hero and
              Achievement gain the same capability instead of Promotion
              forking its own artwork panel. */}
          <p className="text-[11px] font-bold uppercase tracking-wider text-gold mt-5 mb-2">Effects</p>
          <div className="grid grid-cols-2 gap-3">
            <Section title={`Opacity · ${a.opacity ?? 100}%`}>
              <input type="range" min="0" max="100" value={a.opacity ?? 100}
                     data-testid="hero-artwork-opacity"
                     onChange={(e) => commit({ opacity: Number(e.target.value) })}
                     className="w-full accent-[#D4A843]" />
            </Section>
            <Section title={`Blur · ${a.blur ?? 0}px`}>
              <input type="range" min="0" max="20" value={a.blur ?? 0}
                     data-testid="hero-artwork-blur"
                     onChange={(e) => commit({ blur: Number(e.target.value) })}
                     className="w-full accent-[#D4A843]" />
            </Section>
            <Section title={`Brightness · ${a.brightness ?? 100}%`}>
              <input type="range" min="40" max="160" value={a.brightness ?? 100}
                     data-testid="hero-artwork-brightness"
                     onChange={(e) => commit({ brightness: Number(e.target.value) })}
                     className="w-full accent-[#D4A843]" />
            </Section>
            <Section title={`Contrast · ${a.contrast ?? 100}%`}>
              <input type="range" min="40" max="160" value={a.contrast ?? 100}
                     data-testid="hero-artwork-contrast"
                     onChange={(e) => commit({ contrast: Number(e.target.value) })}
                     className="w-full accent-[#D4A843]" />
            </Section>
          </div>

          <div className="mt-3">
            <button
              type="button"
              onClick={() => commit({ overlay: { ...a.overlay, enabled: !a.overlay?.enabled } })}
              data-testid="hero-artwork-overlay-toggle"
              className="inline-flex items-center gap-2 text-[12px] font-bold text-parchment mb-2"
            >
              {a.overlay?.enabled ? <Check className="h-4 w-4 text-green-400" /> : <X className="h-4 w-4 text-faded" />}
              Color overlay
            </button>
            {a.overlay?.enabled && (
              <div className="grid grid-cols-2 gap-3">
                <Section title="Overlay color">
                  <input type="color" data-testid="hero-artwork-overlay-color"
                         value={a.overlay?.color || "#000000"}
                         onChange={(e) => commit({ overlay: { ...a.overlay, color: e.target.value } })}
                         style={{ ...fieldStyle, padding: 4, height: 34 }} />
                </Section>
                <Section title={`Overlay opacity · ${a.overlay?.opacity ?? 40}%`}>
                  <input type="range" min="0" max="100" value={a.overlay?.opacity ?? 40}
                         data-testid="hero-artwork-overlay-opacity"
                         onChange={(e) => commit({ overlay: { ...a.overlay, opacity: Number(e.target.value) } })}
                         className="w-full accent-[#D4A843]" />
                </Section>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
