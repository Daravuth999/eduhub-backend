import { getSoundMode, setSoundMode } from "../soundSettings";

afterEach(() => {
  localStorage.clear();
});

test("defaults to 'soft' when nothing is stored", () => {
  expect(getSoundMode()).toBe("soft");
});

test("round-trips a valid mode through localStorage", () => {
  setSoundMode("normal");
  expect(getSoundMode()).toBe("normal");
  expect(localStorage.getItem("eduhub_sound_mode_v1")).toBe("normal");
});

test("an invalid stored value falls back to the default rather than crashing", () => {
  localStorage.setItem("eduhub_sound_mode_v1", "super-loud");
  expect(getSoundMode()).toBe("soft");
});

test("setSoundMode rejects an invalid value and persists the default instead", () => {
  const result = setSoundMode("super-loud");
  expect(result).toBe("soft");
  expect(getSoundMode()).toBe("soft");
});

test("setSoundMode accepts 'off'", () => {
  setSoundMode("off");
  expect(getSoundMode()).toBe("off");
});
