/**
 * useDashboardBootstrap.js — the Home Dashboard's coordinated startup
 * pipeline. ONE hook Dashboard.jsx calls instead of wiring together
 * several independent per-widget hooks itself.
 *
 * "Coordinated" does NOT mean "blocking" — it does the opposite of what a
 * single `Promise.all` + spinner would do. Each underlying resource hook
 * (useEduHubConfig, useExperienceConfig, useArtworkCampaigns,
 * useNotifications) already:
 *   1. Seeds its OWN state synchronously from its OWN stale-while-revalidate
 *      cache on first render (see swrCache.js / experienceConfigApi.js /
 *      useArtworkCampaigns.js / NotificationContext.jsx) — so this hook's
 *      caller already has last-known-good content available before the
 *      very first paint, with zero fetch having happened yet.
 *   2. Independently kicks off its background network revalidation in its
 *      own `useEffect` on mount — because every one of those effects runs
 *      in the same commit, they fire CONCURRENTLY, not staggered by
 *      component mount order. This hook doesn't need to (and must not)
 *      re-implement that with a manual Promise.all — doing so would
 *      duplicate fetch logic that already exists per-resource, exactly
 *      the kind of "independent implementation per feature" this platform
 *      has avoided elsewhere (see token modules, notification badges).
 *
 * What this hook actually adds: ONE place that composes all five
 * Dashboard Bootstrap resources (Welcome Experience, Artwork Campaign,
 * Activity Feed, Announcements, Notification summary — the last two ride
 * on useEduHubConfig and useNotifications respectively) and derives
 * stable `*Key` content signatures for CrossfadeSwap, so a resource
 * transitioning from its cached guess to a confirmed/refreshed value
 * fades instead of snapping.
 */
import { useEduHubConfig } from "./useEduHubConfig";
import useExperienceConfig from "./useExperienceConfig";
import useArtworkCampaigns from "../components/artwork/useArtworkCampaigns";
import { useNotifications } from "../context/NotificationContext";

const ARTWORK_DASHBOARD_PLACEMENT = "dashboard_hero";

export function useDashboardBootstrap() {
  // Announcements (+ the legacy content source Welcome Experience falls
  // back to). Already stale-while-revalidate internally.
  const eduhub = useEduHubConfig();

  // Welcome Experience: published config (cached) -> legacy Sheets
  // (cached, via eduhub.config above) -> hardcoded default. Resolution
  // priority is unchanged; only the published tier gained a cache this
  // pass (see experienceConfigApi.js).
  const welcome = useExperienceConfig("welcome_dashboard", { legacySource: eduhub.config });

  // Achievement Experience (Top Earner) — same generic Experience Config
  // Platform, same SWR caching, ZERO new infrastructure. No legacy source:
  // there was never a Sheets-driven version of this panel's presentation,
  // so the resolver's fallback tier is just the hardcoded Emerald
  // Achievement default (see achievementConfigResolver.js / TopEarnerPanel).
  const achievement = useExperienceConfig("achievement_top_earner");

  // Promotion Experience — Promotion Experience Studio directive (Phase
  // 1-5). Same generic platform, same SWR caching, ZERO new infrastructure.
  // No legacy source: `config` stays null until an admin actually publishes
  // one, at which point PromotionPanel switches on; until then PromotionPanel
  // itself falls back to the untouched Artwork Campaign System v1.0
  // carousel (see PromotionPanel.jsx), so this resource being empty is not
  // a loading state to guard against here.
  const promotion = useExperienceConfig("promotional_banner");

  // Announcement ticker (Dashboard Showcases, architecture continuation) —
  // same generic Experience Config Platform, same SWR caching. Legacy
  // source is eduhub.config's announcementMessages (the same GAS payload
  // Welcome Experience already falls back to), via
  // legacyAnnouncementAdapter.js — so publishing an Author Studio
  // announcement takes over instantly, and nothing already relying on the
  // GAS ticker breaks until that publish happens.
  const announcement = useExperienceConfig("announcement", { legacySource: eduhub.config });

  // Artwork Campaign — Dashboard Hero placement. Already stale-while-revalidate.
  const artwork = useArtworkCampaigns(ARTWORK_DASHBOARD_PLACEMENT);

  // Activity Feed + Notification summary (unread badges). Only resolves
  // real data once a student is authenticated — that's a genuine
  // dependency (there is no activity to show for a logged-out visitor),
  // not an artificial stagger. `useNotifications()` returns null if
  // rendered outside NotificationProvider; every current caller renders
  // under it, but this hook stays defensive rather than assuming so.
  const notifications = useNotifications();

  // Phase C — the crossfade key must also change when ONLY the Hero
  // Artwork changed (new upload, different placement/scale/padding), not
  // just when title/palette/motion changed. Without url+version here, an
  // admin publishing a pure artwork update would never trigger
  // CrossfadeSwap's smooth transition — the Hero would just snap.
  const heroArtwork = welcome.config?.appearance?.heroArtwork;
  const welcomeKey = welcome.config
    ? `${welcome.source}:${welcome.config.content?.title || ""}:${welcome.config.appearance?.paletteId || ""}:${welcome.config.motion?.presetId || ""}:${heroArtwork?.url || ""}:${heroArtwork?.version ?? ""}`
    : "empty";

  // Same "changed only when a resolved field actually changed" contract as
  // welcomeKey, so publishing a new Achievement preset/decorations/artwork
  // crossfades in smoothly instead of snapping.
  const achievementAppearance = achievement.config?.appearance;
  const achievementArtwork = achievementAppearance?.artwork;
  const achievementKey = achievement.config
    ? `${achievement.source}:${achievementAppearance?.syncMode || ""}:${achievementAppearance?.themeId || ""}:${achievementArtwork?.url || ""}:${achievementArtwork?.version ?? ""}`
    : "empty";

  const artworkKey = artwork.campaigns.length
    ? artwork.campaigns.map((c) => `${c.id}:${c.image_url}`).join("|")
    : "empty";

  // Same "changed only when a resolved field actually changed" contract as
  // welcomeKey/achievementKey — but gated on source === "published" rather
  // than config truthiness. Unlike welcome_dashboard/achievement_top_earner
  // (whose "default" tier is itself a legitimate, fully-specified
  // presentation), promotional_banner has no entry in experienceDefaults.js
  // — its "default" tier is the generic EMPTY fallback (no text, no artwork,
  // no buttons). Gating on config truthiness would never be "empty" (a
  // default object always exists), so PromotionPanel would never fall back
  // to the legacy Artwork Campaign carousel — this is what makes that
  // fallback actually reachable. Includes a content hash (not just ids)
  // since Promotion's textLayers/ctaButtons are author-edited arrays that
  // can change without the config's identity fields changing.
  const promotionIsPublished = promotion.source === "published";
  const promotionAppearance = promotion.config?.appearance;
  const promotionContent = promotion.config?.content;
  const promotionArtwork = promotionAppearance?.artwork;
  // Campaign Design Studio 2.0 — canvas campaigns store their content at
  // content.canvas (not textLayers/ctaButtons), so the key also tracks the
  // published doc's monotonic `version` (bumped on every save). Without it,
  // republishing a canvas campaign whose legacy fields are empty would never
  // change the key and the swap wouldn't crossfade.
  const promotionKey = promotionIsPublished
    ? `${promotion.source}:${promotion.config?.version ?? ""}:${promotionAppearance?.syncMode || ""}:${promotionAppearance?.themeId || ""}:${promotionArtwork?.url || ""}:${promotionArtwork?.version ?? ""}:${JSON.stringify(promotionContent?.textLayers || [])}:${JSON.stringify(promotionContent?.ctaButtons || [])}`
    : "empty";

  return {
    // Per-resource state, unchanged shape from each underlying hook —
    // callers that already destructure e.g. `{ config, source, status }`
    // from useEduHubConfig can switch to `bootstrap.eduhub` with no other
    // changes.
    eduhub,
    welcome,
    achievement,
    promotion,
    announcement,
    artwork,
    notifications,
    // Stable content signatures for CrossfadeSwap `dataKey` props.
    welcomeKey,
    achievementKey,
    promotionKey,
    artworkKey,
  };
}

export default useDashboardBootstrap;
