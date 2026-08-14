import { render, fireEvent, screen } from "@testing-library/react";
import ThemeToggle from "../ThemeToggle";
import { playUiSound } from "../../audio/uiSoundEngine";

jest.mock("../../audio/uiSoundEngine", () => ({
  playUiSound: jest.fn(),
}));

jest.mock("../../lib/themeAuto", () => ({
  setThemePreference: jest.fn(),
  getThemeMode: jest.fn(() => "auto"),
  getActiveTheme: jest.fn(() => "light"),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

test("clicking the theme toggle plays 'toggle'", () => {
  render(<ThemeToggle />);
  fireEvent.click(screen.getByTestId("theme-toggle-button"));
  expect(playUiSound).toHaveBeenCalledWith("toggle");
});
