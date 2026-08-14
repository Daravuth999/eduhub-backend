import { render, screen, fireEvent } from "@testing-library/react";
import { useSoundSettings } from "../useSoundSettings";

function Harness() {
  const { mode, setMode } = useSoundSettings();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button onClick={() => setMode("normal")}>normal</button>
      <button onClick={() => setMode("off")}>off</button>
    </div>
  );
}

afterEach(() => {
  localStorage.clear();
});

test("initializes from storage (default 'soft')", () => {
  render(<Harness />);
  expect(screen.getByTestId("mode")).toHaveTextContent("soft");
});

test("setMode updates state and persists to storage", () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("normal"));
  expect(screen.getByTestId("mode")).toHaveTextContent("normal");
  expect(localStorage.getItem("eduhub_sound_mode_v1")).toBe("normal");
});

test("setMode('off') is reflected immediately", () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("off"));
  expect(screen.getByTestId("mode")).toHaveTextContent("off");
});
