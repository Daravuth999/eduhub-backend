/**
 * AssetLibraryPanel.jsx — premium asset packs + uploaded media library.
 *
 * • Packs come from assetManifest.js (extensible — future packs plug in).
 * • Uploads reuse the EXISTING hero-artwork media library API
 *   (uploadHeroArtwork / listHeroArtworkLibrary in studio/api.js).
 * • Insert actions implement the four artwork modes: Hero (default click),
 *   BG (set as background image), Poster (exact-render poster layer).
 */
import { useEffect, useRef, useState } from "react";
import { Search, UploadCloud, Loader2, ImagePlus, Wallpaper, Frame } from "lucide-react";
import { ASSET_PACKS } from "../assetManifest";
import { insertAsset } from "../editorState";
import { uploadHeroArtwork, listHeroArtworkLibrary } from "../../api";

function AssetCard({ asset, onHero, onBackground, onPoster }) {
  return (
    <div
      className="group relative rounded-xl overflow-hidden"
      style={{ background: "rgba(45,31,62,0.45)", border: "1px solid rgba(212,168,67,0.16)" }}
      data-testid={`asset-card-${asset.id}`}
    >
      <div className="aspect-square grid place-items-center p-2">
        <img src={asset.src} alt={asset.label} loading="lazy" className="max-h-full max-w-full object-contain"
             style={{ filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.35))" }} />
      </div>
      <p className="px-2 pb-1.5 text-[10px] font-semibold text-parchment/90 truncate">{asset.label}</p>
      <div className="absolute inset-0 hidden group-hover:flex flex-col items-center justify-center gap-1"
           style={{ background: "rgba(13,10,22,0.82)", backdropFilter: "blur(3px)" }}>
        <button type="button" onClick={onHero} data-testid={`asset-add-hero-${asset.id}`}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[9.5px] font-bold uppercase tracking-wider text-ink"
                style={{ background: "linear-gradient(135deg,#FFE19A,#D4A843)", color: "#1a1420" }}>
          <ImagePlus className="h-3 w-3" /> Hero
        </button>
        <div className="flex gap-1">
          <button type="button" onClick={onBackground} data-testid={`asset-add-bg-${asset.id}`}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-parchment"
                  style={{ background: "rgba(45,31,62,0.9)", border: "1px solid rgba(212,168,67,0.3)" }}>
            <Wallpaper className="h-3 w-3" /> BG
          </button>
          <button type="button" onClick={onPoster} data-testid={`asset-add-poster-${asset.id}`}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-parchment"
                  style={{ background: "rgba(45,31,62,0.9)", border: "1px solid rgba(212,168,67,0.3)" }}>
            <Frame className="h-3 w-3" /> Poster
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AssetLibraryPanel({ state, dispatch }) {
  const [query, setQuery] = useState("");
  const [activePack, setActivePack] = useState("finance");
  const [uploads, setUploads] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [loadingUploads, setLoadingUploads] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingUploads(true);
    listHeroArtworkLibrary()
      .then((r) => { if (!cancelled) setUploads(r?.assets || []); })
      .catch(() => { if (!cancelled) setUploads([]); })
      .finally(() => { if (!cancelled) setLoadingUploads(false); });
    return () => { cancelled = true; };
  }, []);

  const doInsert = (asset, role) => {
    if (role === "background") {
      const bg = state.canvas.layers.find((l) => l.type === "background");
      if (bg) {
        dispatch({ type: "UPDATE_LAYER", id: bg.id, patch: { image: { ...bg.image, src: asset.src, fit: "cover" } } });
        dispatch({ type: "SELECT", id: bg.id });
      }
      return;
    }
    insertAsset(dispatch, asset, { role });
    if (role === "poster") dispatch({ type: "UPDATE_CANVAS", patch: { artworkMode: "poster" } });
  };

  const handleUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const r = await uploadHeroArtwork(file);
      if (r?.asset) setUploads((prev) => [r.asset, ...prev]);
    } catch (e) {
      setError(e?.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const q = query.trim().toLowerCase();
  const packs = ASSET_PACKS.map((p) => ({
    ...p,
    assets: q ? p.assets.filter((a) => a.label.toLowerCase().includes(q)) : p.assets,
  }));
  const visiblePack = q ? { assets: packs.flatMap((p) => p.assets) } : packs.find((p) => p.id === activePack) || packs[0];

  return (
    <div className="flex flex-col gap-3" data-testid="asset-library-panel">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-faded" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search assets…"
          data-testid="asset-library-search-input"
          className="w-full rounded-full pl-9 pr-3 py-2 text-[12px] outline-none"
          style={{ background: "rgba(20,14,32,0.7)", border: "1px solid rgba(212,168,67,0.25)", color: "#F4E5C1" }}
        />
      </div>

      {!q && (
        <div className="flex flex-wrap gap-1">
          {ASSET_PACKS.map((p) => (
            <button key={p.id} type="button" onClick={() => setActivePack(p.id)}
                    data-testid={`asset-pack-${p.id}`}
                    className="rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors"
                    style={{
                      background: activePack === p.id ? "rgba(212,168,67,0.16)" : "rgba(45,31,62,0.55)",
                      border: activePack === p.id ? "1px solid rgba(212,168,67,0.5)" : "1px solid rgba(212,168,67,0.18)",
                      color: "#F4E5C1",
                    }}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-1.5">
        {visiblePack.assets.map((a) => (
          <AssetCard
            key={a.id}
            asset={a}
            onHero={() => doInsert(a, "hero")}
            onBackground={() => doInsert(a, "background")}
            onPoster={() => doInsert(a, "poster")}
          />
        ))}
        {!visiblePack.assets.length && (
          <p className="col-span-3 text-center text-[11px] text-faded py-4">No assets match “{query}”</p>
        )}
      </div>

      {/* ── uploads (existing hero-artwork media library) ── */}
      <div className="mt-1 pt-3" style={{ borderTop: "1px solid rgba(212,168,67,0.16)" }}>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-faded">My uploads</p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            data-testid="asset-library-upload-button"
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink"
            style={{ background: "linear-gradient(135deg,#FFE19A,#D4A843,#9C7A2C)", color: "#1a1420" }}
          >
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <UploadCloud className="h-3 w-3" />}
            Upload
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/webp,image/svg+xml,image/jpeg" className="hidden"
                 onChange={(e) => handleUpload(e.target.files?.[0])} data-testid="asset-library-upload-input" />
        </div>
        {error && <p className="text-[10.5px] text-red-300 mb-2" data-testid="asset-library-upload-error">{error}</p>}
        {loadingUploads ? (
          <div className="grid place-items-center py-4"><Loader2 className="h-4 w-4 animate-spin text-gold" /></div>
        ) : uploads.length ? (
          <div className="grid grid-cols-3 gap-1.5">
            {uploads.map((u) => (
              <AssetCard
                key={u.id}
                asset={{ id: u.id, label: "Upload", src: u.url, aspect: u.width && u.height ? u.width / u.height : 1 }}
                onHero={() => doInsert({ id: u.id, label: "Upload", src: u.url, aspect: u.width && u.height ? u.width / u.height : 1 }, "hero")}
                onBackground={() => doInsert({ src: u.url }, "background")}
                onPoster={() => doInsert({ id: u.id, label: "Poster", src: u.url, aspect: u.width && u.height ? u.width / u.height : 1 }, "poster")}
              />
            ))}
          </div>
        ) : (
          <p className="text-[10.5px] text-faded">Upload transparent PNG / WebP / SVG artwork — it lands in the shared media library.</p>
        )}
      </div>
    </div>
  );
}
