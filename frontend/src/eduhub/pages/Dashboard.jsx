// Dashboard.jsx — public landing (/). Re-ordered per UI/UX redesign spec
//   (2026-01): Hero → AnnouncementStrip (40px) → TopFiveStrip (~120px)
//   → LibraryShowcase → FeaturedFeatures (Portal + Lucky Spin)
//   → QuickAccessGrid. Backend hooks (useEduHubConfig, useTopEarners, getContent)
//   are reused unchanged.
import Hero from "../components/Hero";
import AnnouncementStrip from "../components/AnnouncementStrip";
import LibraryShowcase from "../components/LibraryShowcase";
import TopFiveStrip from "../components/TopFiveStrip";
import QuickAccessGrid from "../components/QuickAccessGrid";
import FeaturedFeatures from "./FeaturedFeatures-host";

import { useEduHubConfig } from "../hooks/useEduHubConfig";

export default function Dashboard() {
  const { config, source, status, statusText, retry } = useEduHubConfig();

  return (
    <>
      <Hero
        title={config.title}
        khmerWelcome={config.khmerWelcome}
        subtitle={config.subtitle}
        instructorName={config.instructorName}
      />

      {/* Compact 40px announcement strip */}
      <AnnouncementStrip
        config={config}
        fetchStatus={status}
        fetchStatusText={statusText}
        source={source}
        onRetry={retry}
      />

      {/* ~120px Top 5 strip */}
      <TopFiveStrip />

      {/* Library showcase (gold border, 3D books) */}
      <LibraryShowcase />

      {/* 2-column feature cards: My Portal + Lucky Spin */}
      <FeaturedFeatures />

      {/* Quick Access tiles */}
      <QuickAccessGrid />
    </>
  );
}
