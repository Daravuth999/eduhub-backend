import { formatPoints, formatPointsGrouped } from "../formatPoints";

test("strips binary floating-point artifacts", () => {
  expect(formatPoints(82.0200000000000001)).toBe("82.02");
});

test("whole numbers render with no decimal point", () => {
  expect(formatPoints(82)).toBe("82");
  expect(formatPoints(1000)).toBe("1000");
});

test("preserves a genuine single decimal", () => {
  expect(formatPoints(105.5)).toBe("105.5");
});

test("never adds a thousands separator", () => {
  expect(formatPoints(1000)).not.toMatch(/,/);
});

test("rounds to at most 2 decimal places", () => {
  expect(formatPoints(1.239)).toBe("1.24");
  expect(formatPoints(1.001)).toBe("1"); // rounds away a 3rd-decimal artifact entirely
});

test("null/undefined/non-numeric input falls back to 0, never crashes", () => {
  expect(formatPoints(null)).toBe("0");
  expect(formatPoints(undefined)).toBe("0");
  expect(formatPoints("not a number")).toBe("0");
});

describe("formatPointsGrouped", () => {
  // The exact production incident this variant exists to fix: the Video
  // Library dashboard rendered a raw JS float straight into the DOM.
  test("strips the reported production float-precision leak", () => {
    expect(formatPointsGrouped(154.15999999999988)).toBe("154.16");
  });

  test("integer-valued floats show no decimals", () => {
    expect(formatPointsGrouped(154.0000001)).toBe("154");
  });

  test("preserves a genuine single decimal", () => {
    expect(formatPointsGrouped(154.1)).toBe("154.1");
  });

  test("adds locale-aware thousands separators", () => {
    expect(formatPointsGrouped(1200)).toBe("1,200");
    expect(formatPointsGrouped(18250)).toBe("18,250");
  });

  test("rounds to at most 2 decimal places", () => {
    expect(formatPointsGrouped(82.0200000000000001)).toBe("82.02");
    expect(formatPointsGrouped(1.239)).toBe("1.24");
  });

  test("zero renders as a plain 0, not an empty string or NaN", () => {
    expect(formatPointsGrouped(0)).toBe("0");
  });

  test("null/undefined/non-numeric input falls back to 0, never crashes", () => {
    expect(formatPointsGrouped(null)).toBe("0");
    expect(formatPointsGrouped(undefined)).toBe("0");
    expect(formatPointsGrouped("not a number")).toBe("0");
  });
});
