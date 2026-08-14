import { render } from "@testing-library/react";
import SoundUnlockProvider from "../SoundUnlockProvider";
import * as engine from "../uiSoundEngine";
import * as settings from "../soundSettings";

jest.mock("../uiSoundEngine", () => ({
  unlockAudio: jest.fn(),
}));
jest.mock("../soundSettings", () => ({
  initSoundModeFromStorage: jest.fn(),
}));

test("renders nothing", () => {
  const { container } = render(<SoundUnlockProvider />);
  expect(container).toBeEmptyDOMElement();
});

test("initializes the stored sound mode on mount", () => {
  render(<SoundUnlockProvider />);
  expect(settings.initSoundModeFromStorage).toHaveBeenCalledTimes(1);
});

test("calls unlockAudio synchronously on the first pointerdown, and only once", () => {
  render(<SoundUnlockProvider />);
  document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(engine.unlockAudio).toHaveBeenCalledTimes(1);
});

test("calls unlockAudio on the first touchend if pointerdown never fires", () => {
  render(<SoundUnlockProvider />);
  document.dispatchEvent(new Event("touchend", { bubbles: true }));
  expect(engine.unlockAudio).toHaveBeenCalledTimes(1);
});
