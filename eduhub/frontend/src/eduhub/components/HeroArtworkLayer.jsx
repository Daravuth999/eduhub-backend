// HeroArtworkLayer.jsx — renders one Hero Artwork composition layer.
// Pure presentation, no config-resolution logic (matches Hero.jsx's own
// contract). Hero.jsx mounts this at one of four DOM positions depending
// on heroArtwork.layerOrder — see heroArtworkSchema.js for the shared
// layout math both this component and the Studio's live preview rely on.
//
// Offline durability: the network URL is used immediately (the common
// case), but every mount also preloads the current artwork into the
// offline Cache Storage entry (heroArtworkCache.js) in the background, and
// falls back to that cached copy — via a blob: object URL — if the image
// fails to load (offline, R2 hiccup, captive portal). This is genuinely
// concurrent with the rest of Dashboard Bootstrap: it fires the moment
// Hero first renders with a heroArtwork.url, which happens on the SAME
// synchronous first paint as the cached Welcome Experience config itself.
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { getArtworkLayout } from "../lib/experienceConfig/heroArtworkSchema";
import {
  getCachedArtworkObjectUrl,
  preloadAndCacheArtwork,
  clearStaleArtworkCache,
} from "../lib/heroArtworkCache";

export default function HeroArtworkLayer({ heroArtwork, animateEnabled }) {
  const url = heroArtwork?.url || null;
  const [src, setSrc] = useState(url);
  const objectUrlRef = useRef(null);

  useEffect(() => {
    setSrc(url);
    if (!url) return undefined;

    let cancelled = false;
    // Phase C — once the NEW artwork is confirmed cached, evict every
    // OTHER cached entry (a prior asset/version this url replaced). Only
    // after confirming the new one is safely stored, so a failed preload
    // (offline, R2 hiccup) never leaves the offline cache empty — the
    // previous artwork stays available until its replacement truly lands.
    preloadAndCacheArtwork(url).then((cached) => {
      if (cached && !cancelled) clearStaleArtworkCache(url);
    });

    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      void cancelled;
    };
  }, [url]);

  const handleError = async () => {
    if (!url) return;
    const cached = await getCachedArtworkObjectUrl(url);
    if (cached) {
      objectUrlRef.current = cached;
      setSrc(cached);
    }
  };

  if (!heroArtwork || !url) return null;
  const { containerStyle, imgStyle } = getArtworkLayout(heroArtwork);

  return (
    <div aria-hidden style={containerStyle} data-testid="hero-artwork-layer">
      <motion.img
        src={src}
        alt=""
        style={imgStyle}
        initial={animateEnabled ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        draggable={false}
        onError={handleError}
        data-testid="hero-artwork-image"
      />
    </div>
  );
}
