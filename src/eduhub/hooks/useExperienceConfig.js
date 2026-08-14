/**
 * useExperienceConfig.js — the ONE hook every experience surface uses to
 * get its fully-resolved configuration. Generic over experienceType; has
 * zero knowledge of Google Sheets, Welcome Dashboard, or any specific
 * presentation component.
 *
 * Usage (Welcome Dashboard today):
 *   const sheetsConfig = useEduHubConfig();           // existing hook, untouched
 *   const { config, loading, source } =
 *     useExperienceConfig("welcome_dashboard", { legacySource: sheetsConfig.config });
 *   <Hero config={config} />
 *
 * A future experience with NO legacy source simply omits `legacySource` —
 * the resolver falls straight from "published" to "default" for it.
 */
import { useEffect, useRef, useState } from "react";
import {
  fetchActiveExperienceConfig, getCachedActiveExperienceConfig,
} from "../lib/experienceConfig/experienceConfigApi";
import { resolveExperienceConfig } from "../lib/experienceConfig/resolveExperienceConfig";
import { getExperienceDefault } from "../lib/experienceConfig/experienceDefaults";

export function useExperienceConfig(experienceType, { legacySource = null } = {}) {
  const [state, setState] = useState(() => {
    // Dashboard Bootstrap: seed the very first paint with the last
    // successfully fetched published config (if any) rather than always
    // starting from the legacy/default tier and waiting for the network —
    // a returning visitor sees the correct published experience
    // immediately, with the live fetch below only confirming/revalidating.
    const cachedPublished = getCachedActiveExperienceConfig(experienceType);
    const { config, source } = resolveExperienceConfig(experienceType, cachedPublished, legacySource);
    return { config, source, loading: true };
  });

  const legacySourceRef = useRef(legacySource);
  legacySourceRef.current = legacySource;

  useEffect(() => {
    let cancelled = false;
    fetchActiveExperienceConfig(experienceType).then((publishedConfig) => {
      if (cancelled) return;
      const resolved = resolveExperienceConfig(experienceType, publishedConfig, legacySourceRef.current);
      setState({ ...resolved, loading: false });
    });
    return () => { cancelled = true; };
    // Intentionally re-fetch only when the experienceType itself changes —
    // NOT on every legacySource reference change (e.g. useEduHubConfig's
    // periodic re-fetch). If a published config is already active it wins
    // regardless of legacy data changing; if we're on the legacy tier, the
    // effect below keeps content in sync without re-hitting the backend.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experienceType]);

  // If we're currently resolved from the legacy tier (no published config
  // exists) and the legacy source itself updates (e.g. Sheets re-fetch
  // resolves after we first rendered defaults), re-resolve WITHOUT a new
  // backend round trip.
  useEffect(() => {
    setState((prev) => {
      if (prev.source === "published") return prev; // published always wins
      const resolved = resolveExperienceConfig(experienceType, null, legacySource);
      if (resolved.source === prev.source && resolved.config === prev.config) return prev;
      return { ...resolved, loading: prev.loading };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experienceType, legacySource]);

  return state;
}

export function getExperienceConfigDefault(experienceType) {
  return getExperienceDefault(experienceType);
}

export default useExperienceConfig;
