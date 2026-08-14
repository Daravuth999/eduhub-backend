/**
 * voiceTreasure_pass3.test.jsx — Pass 3 surgical UI tests.
 *
 * Source-presence tests covering: identity hook + header on the remaining
 * Voice Treasure screens (EntryConfirm, Mission, Recorder, Evaluation, Chest,
 * Collection, Progress, Unavailable), absence of Lucky Spin inside VT,
 * localized instruction surface on Mission, evaluation stage transitions,
 * collection/progress truthful authoritative-data rendering, and zero
 * regression on the protected Home tiles.
 */
import fs from "fs";
import path from "path";

const VT = (f) => path.join(__dirname, "..", f);
const read = (f) => fs.readFileSync(VT(f), "utf8");

const VT_SCREENS = [
  "VoiceTreasureEntryConfirm.jsx",
  "VoiceTreasureMission.jsx",
  "VoiceTreasureRecorder.jsx",
  "VoiceTreasureEvaluation.jsx",
  "VoiceTreasureChest.jsx",
  "VoiceTreasureCollection.jsx",
  "VoiceTreasureProgress.jsx",
  "VoiceTreasureUnavailable.jsx",
];

describe("Pass 3 — Voice Treasure identity on remaining screens", () => {
  test.each(VT_SCREENS)("%s renders <VoiceTreasureIdentity/>", (file) => {
    const src = read(file);
    expect(src).toMatch(/<VoiceTreasureIdentity/);
    expect(src).toMatch(/useVoiceTreasureTitle\(/);
  });

  test.each(VT_SCREENS)("%s does NOT contain a 'Lucky Spin' label", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/\bLucky Spin\b/);
  });

  test("chest screen uses the explicit Treasure Chest title and no unused legacy import", () => {
    const src = read("VoiceTreasureChest.jsx");
    expect(src).toMatch(/useVoiceTreasureTitle\(["']Treasure Chest["']\)/);
    // Pass 3 audit fix: drop unused legacy `chestAssetForState` symbol.
    expect(src).not.toMatch(/\bchestAssetForState\b/);
  });
});

describe("Pass 3 — Mission surfaces SERVER-AUTHORITATIVE bilingual instruction", () => {
  const missionSrc = read("VoiceTreasureMission.jsx");

  test("Mission reads `language.instruction` from /today response", () => {
    expect(missionSrc).toMatch(/t\.language/);
    expect(missionSrc).toMatch(/language\?\.instruction/);
  });

  test("Mission renders Khmer with lang=\"km\" when configured", () => {
    expect(missionSrc).toMatch(/lang=["']km["']/);
  });

  test("Mission surfaces the accepted response language label", () => {
    expect(missionSrc).toMatch(/data-testid=["']vt-mission-language-label["']/);
    expect(missionSrc).toMatch(/accepted_response_label/);
  });

  test("Mission shows an Entry-paid indicator", () => {
    expect(missionSrc).toMatch(/vt-mission-paid/);
    expect(missionSrc).toMatch(/Entry paid/);
  });

  test("Mission still blocks submission when the assigned image fails to load", () => {
    expect(missionSrc).toMatch(/safeToSubmit/);
    expect(missionSrc).toMatch(/vt-mission-img-error/);
  });
});

describe("Pass 3 — Evaluation transition", () => {
  const src = read("VoiceTreasureEvaluation.jsx");

  test("uses staged coaching cues (no fake percentages)", () => {
    expect(src).toMatch(/Analyzing the scene/);
    expect(src).toMatch(/Preparing your coaching/);
    expect(src).toMatch(/Finalizing your result/);
    // No fake numeric progress is rendered:
    expect(src).not.toMatch(/\b\d+%\b/);
  });

  test("respects prefers-reduced-motion", () => {
    expect(src).toMatch(/prefers-reduced-motion/);
  });

  test("evaluation has accessible status role", () => {
    expect(src).toMatch(/role=["']status["']/);
    expect(src).toMatch(/aria-live/);
  });
});

describe("Pass 3 — Collection truthfulness", () => {
  const src = read("VoiceTreasureCollection.jsx");

  test("loads from authoritative backend; no fabricated ownership", () => {
    expect(src).toMatch(/api\.getCollection\(\)/);
    expect(src).toMatch(/first_voice_card_owned/);
    expect(src).not.toMatch(/localStorage/);
  });

  test("renders an empty-state when nothing is owned", () => {
    expect(src).toMatch(/vt-collection-empty/);
    expect(src).toMatch(/vt-card-state/);
  });

  test("Pass B.2.1 truth correction — no rarity/category invention, truthful descriptor instead", () => {
    expect(src).not.toMatch(/Rarity:/);
    expect(src).not.toMatch(/Rarity: Rare/);
    expect(src).toMatch(/Voice Treasure collectible/);
    expect(src).toMatch(/granted_at/);
  });
});

describe("Pass 3 — Progress authoritative-data view", () => {
  const src = read("VoiceTreasureProgress.jsx");

  test("only authoritative fields are rendered (no client-side persistence as source of truth)", () => {
    // The intent is `localStorage` must not be the SOURCE OF TRUTH. We allow
    // it to appear inside the doc-comment that explicitly says it isn't used.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/localStorage/);
    expect(src).toMatch(/api\.getProgress\(\)/);
    for (const field of [
      "missions_completed",
      "current_streak",
      "longest_streak",
      "points_spent",
      "points_earned",
      "first_voice_card_owned",
    ]) {
      expect(src).toContain(field);
    }
  });

  test("renders strongest/improvement categories when authoritative data provides them", () => {
    expect(src).toMatch(/strongest_category/);
    expect(src).toMatch(/improvement_category/);
  });

  test("shows the empty-state when missions_completed is 0", () => {
    expect(src).toMatch(/vt-progress-empty/);
  });
});

describe("Pass 3 — Backend bilingual wiring proven from frontend perspective", () => {
  // The frontend doesn't decide language; it must trust the server.
  test("Mission never overrides server-decided language", () => {
    const src = read("VoiceTreasureMission.jsx");
    expect(src).not.toMatch(/response_language\s*=\s*["']/);
    expect(src).not.toMatch(/feedback_language\s*=\s*["']/);
  });
});

describe("Pass 3 — Protected perimeter: original Home tiles untouched", () => {
  // The five original tiles live in src/eduhub/pages/home or similar.
  test("no VT change removes or renames an original Home tile (smoke)", () => {
    // We don't import Home here; we simply assert no VT file accidentally
    // imports/mutates Home tile constants.
    for (const file of VT_SCREENS) {
      const src = read(file);
      expect(src).not.toMatch(/HOME_TILES|homeTiles|originalHomeTiles/);
    }
  });
});
