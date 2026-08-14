/**
 * studioCommandPalette.test.jsx — Studio OS command palette (tools +
 * universal entity search).
 *
 * Mounts the REAL StudioCommandPalette (real `cmdk`, real Radix Dialog
 * under it — no mocking of either, since this file exists specifically to
 * prove the actual integration behaves, not a stand-in). Only the entity
 * list functions (listStudents/listStudioBooks/listCoupons/listEvents)
 * are mocked — jsdom has no `fetch`, and these are real network calls in
 * production; mocking them keeps the test deterministic and offline.
 *
 * Covers the two guards added during the independent Phase 0 audit: never
 * steal Ctrl/Cmd+K from a focused text field, and never pop open on top of
 * an existing `[aria-modal="true"]` dialog elsewhere in Studio (the
 * concrete collision found against LoginRewardStudio.jsx's push-send
 * confirm) — plus the universal-search expansion added afterward.
 */
import { render, screen, fireEvent, within, waitFor, act } from "@testing-library/react";
import { PenSquare, GraduationCap } from "lucide-react";
import StudioCommandPalette from "../StudioCommandPalette";

jest.mock("../../eduhub/auth/studentAuthService", () => ({
  listStudents: jest.fn(),
}));
jest.mock("../api", () => ({
  listStudioBooks: jest.fn(),
  listCoupons: jest.fn(),
  listEvents: jest.fn(),
}));
const { listStudents } = require("../../eduhub/auth/studentAuthService");
const { listStudioBooks, listCoupons, listEvents } = require("../api");

const TABS = [
  { key: "editor", label: "Editor", Icon: PenSquare },
  { key: "teacher", label: "Students", Icon: GraduationCap },
];

function pressCtrlK(target = document.body) {
  fireEvent.keyDown(target, { key: "k", ctrlKey: true });
}

beforeEach(() => {
  listStudents.mockResolvedValue([]);
  listStudioBooks.mockResolvedValue([]);
  listCoupons.mockResolvedValue([]);
  listEvents.mockResolvedValue([]);
});

test("clicking the search trigger opens the palette listing every tab", () => {
  render(<StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />);
  fireEvent.click(screen.getByTestId("studio-search-trigger"));
  expect(screen.getByTestId("studio-command-palette")).toBeInTheDocument();
  expect(screen.getByTestId("studio-command-item-editor")).toBeInTheDocument();
  expect(screen.getByTestId("studio-command-item-teacher")).toBeInTheDocument();
});

test("Ctrl+K opens the palette from anywhere in Studio", () => {
  render(<StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />);
  expect(screen.queryByTestId("studio-command-palette")).not.toBeInTheDocument();
  pressCtrlK();
  expect(screen.getByTestId("studio-command-palette")).toBeInTheDocument();
});

test("selecting a tool calls onSelect with its key and closes the palette", () => {
  const onSelect = jest.fn();
  render(<StudioCommandPalette tabs={TABS} onSelect={onSelect} />);
  pressCtrlK();
  fireEvent.click(screen.getByTestId("studio-command-item-teacher"));
  expect(onSelect).toHaveBeenCalledWith("teacher");
  expect(screen.queryByTestId("studio-command-palette")).not.toBeInTheDocument();
});

describe("audit fix — does not steal Ctrl/Cmd+K from a focused text field", () => {
  test("an <input> target suppresses the shortcut", () => {
    render(
      <div>
        <input data-testid="some-studio-field" />
        <StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />
      </div>
    );
    pressCtrlK(screen.getByTestId("some-studio-field"));
    expect(screen.queryByTestId("studio-command-palette")).not.toBeInTheDocument();
  });

  test("a <textarea> target suppresses the shortcut", () => {
    render(
      <div>
        <textarea data-testid="some-studio-textarea" />
        <StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />
      </div>
    );
    pressCtrlK(screen.getByTestId("some-studio-textarea"));
    expect(screen.queryByTestId("studio-command-palette")).not.toBeInTheDocument();
  });

  test("a contentEditable target suppresses the shortcut", () => {
    render(
      <div>
        <div data-testid="rich-text-field" contentEditable="true" suppressContentEditableWarning />
        <StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />
      </div>
    );
    pressCtrlK(screen.getByTestId("rich-text-field"));
    expect(screen.queryByTestId("studio-command-palette")).not.toBeInTheDocument();
  });

  test("a non-editable target (e.g. document.body) still opens it", () => {
    render(<StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />);
    pressCtrlK(document.body);
    expect(screen.getByTestId("studio-command-palette")).toBeInTheDocument();
  });
});

describe("audit fix — never pops open on top of an existing Studio modal", () => {
  test("does not open while another [aria-modal=true] dialog is present (the LoginRewardStudio z-[1000] collision)", () => {
    const { container } = render(
      <div>
        <div role="dialog" aria-modal="true" data-testid="lrc-push-confirm">
          Send push notification?
        </div>
        <StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />
      </div>
    );
    pressCtrlK();
    expect(screen.queryByTestId("studio-command-palette")).not.toBeInTheDocument();
    // the pre-existing modal is completely undisturbed
    expect(within(container).getByTestId("lrc-push-confirm")).toBeInTheDocument();
  });

  test("the SAME shortcut still closes an already-open palette even if another modal appears afterwards", () => {
    render(<StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />);
    pressCtrlK();
    expect(screen.getByTestId("studio-command-palette")).toBeInTheDocument();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);

    pressCtrlK();
    expect(screen.queryByTestId("studio-command-palette")).not.toBeInTheDocument();

    document.body.removeChild(dialog);
  });

  test("clicking the visible search trigger button still works even with a modal open elsewhere (explicit user intent beats the guard)", () => {
    render(
      <div>
        <div role="dialog" aria-modal="true">Some other dialog</div>
        <StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />
      </div>
    );
    fireEvent.click(screen.getByTestId("studio-search-trigger"));
    expect(screen.getByTestId("studio-command-palette")).toBeInTheDocument();
  });
});

describe("universal search — entities beyond tool names", () => {
  test("entity lists are NOT fetched until the palette is actually opened", () => {
    render(<StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />);
    expect(listStudents).not.toHaveBeenCalled();
    expect(listStudioBooks).not.toHaveBeenCalled();
    expect(listCoupons).not.toHaveBeenCalled();
    expect(listEvents).not.toHaveBeenCalled();
  });

  test("opening the palette fetches all four entity types exactly once", async () => {
    render(<StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />);
    fireEvent.click(screen.getByTestId("studio-search-trigger"));
    await waitFor(() => expect(listStudents).toHaveBeenCalledTimes(1));
    expect(listStudioBooks).toHaveBeenCalledTimes(1);
    expect(listCoupons).toHaveBeenCalledTimes(1);
    expect(listEvents).toHaveBeenCalledTimes(1);

    // Closing and reopening must NOT refetch — cached for the session.
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByTestId("studio-search-trigger"));
    expect(listStudents).toHaveBeenCalledTimes(1);
  });

  test("a real student result renders with its display name and navigates to Students on select", async () => {
    listStudents.mockResolvedValue([{ clean_id: "stu001", display_name: "Sokha Chan" }]);
    const onSelect = jest.fn();
    render(<StudioCommandPalette tabs={TABS} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("studio-search-trigger"));

    const row = await screen.findByTestId("studio-command-entity-students-stu001");
    expect(within(row).getByText("Sokha Chan")).toBeInTheDocument();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("teacher");
  });

  test("a real book result renders its title and Live/Draft status and navigates to Browse on select", async () => {
    listStudioBooks.mockResolvedValue([{ slug: "the-lantern-path", title: "The Lantern Path", published: true }]);
    const onSelect = jest.fn();
    render(<StudioCommandPalette tabs={TABS} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("studio-search-trigger"));

    const row = await screen.findByTestId("studio-command-entity-books-the-lantern-path");
    expect(within(row).getByText("The Lantern Path")).toBeInTheDocument();
    expect(within(row).getByText("Live")).toBeInTheDocument();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("browse");
  });

  test("a real coupon result navigates to Coupons on select", async () => {
    listCoupons.mockResolvedValue([{ code: "WELCOME20", enabled: true }]);
    const onSelect = jest.fn();
    render(<StudioCommandPalette tabs={TABS} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("studio-search-trigger"));

    const row = await screen.findByTestId("studio-command-entity-coupons-WELCOME20");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("coupons");
  });

  test("a real event result navigates to Event Templates on select", async () => {
    listEvents.mockResolvedValue([{ _id: "evt_1", name: "Spring Reading Challenge", state: "live" }]);
    const onSelect = jest.fn();
    render(<StudioCommandPalette tabs={TABS} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("studio-search-trigger"));

    const row = await screen.findByTestId("studio-command-entity-events-evt_1");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("eventtemplates");
  });

  test("an entity type that returns nothing renders no group for it, without breaking the others", async () => {
    listStudents.mockResolvedValue([{ clean_id: "stu001", display_name: "Sokha Chan" }]);
    listStudioBooks.mockResolvedValue([]);
    render(<StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />);
    fireEvent.click(screen.getByTestId("studio-search-trigger"));

    await screen.findByTestId("studio-command-entity-students-stu001");
    expect(screen.queryByText("Books")).not.toBeInTheDocument();
  });

  test("a rejected entity fetch (e.g. network error) does not crash the palette or block other entity types", async () => {
    listStudents.mockRejectedValue(new Error("network down"));
    listStudioBooks.mockResolvedValue([{ slug: "ok-book", title: "Still Works", published: false }]);
    render(<StudioCommandPalette tabs={TABS} onSelect={jest.fn()} />);
    fireEvent.click(screen.getByTestId("studio-search-trigger"));

    await screen.findByTestId("studio-command-entity-books-ok-book");
    expect(screen.getByTestId("studio-command-palette")).toBeInTheDocument();
  });
});
