// CommunityPulse.jsx — "Community Pulse" section (Home Dashboard RC2.9).
//
// RC2.9 splits what used to live in one "Community Pulse" section into
// its correct places per the RC2.9 information architecture, where
// "Community Pulse" ("What is happening around me?") and "Learning
// Progress" ("How am I progressing?") are two separate top-level
// Dashboard sections, not one nested inside the other:
//   • LiveActivityStrip (the student's own personal notification feed)
//     is superseded by the new ActivityTimeline section directly below
//     Hero — showing the same personal feed in two places on one page
//     would be a duplicate, not a second real signal. Removed from here;
//     the file itself is left on disk unused (rollback-safety convention
//     this codebase already uses elsewhere).
//   • MyRankCard ("Your Rank") is superseded by the new top-level
//     LearningProgress section (see Dashboard.jsx) — removed from here
//     for the same reason; also left on disk unused.
//   • WinnerShowcaseBanner (settlement-confirmed Lucky Draw winners) is
//     the one tile that's genuinely "what's happening around me" (public,
//     community-wide, not personal) — kept completely unchanged, still
//     ungated (shown to guests too), still carrying its own "Event —
//     Winners" label so no separate section heading is needed here.
//
// A live concurrent-presence count ("N students studying now") remains
// NOT VERIFIED to exist anywhere in this codebase or its backend — still
// omitted rather than fabricated, same as every prior Dashboard phase.
import WinnerShowcaseBanner from "../WinnerShowcaseBanner";

export default function CommunityPulse() {
  return (
    <section data-testid="community-pulse">
      <WinnerShowcaseBanner />
    </section>
  );
}
