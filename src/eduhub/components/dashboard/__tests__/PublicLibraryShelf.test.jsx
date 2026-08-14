import { render, screen, waitFor } from "@testing-library/react";
import PublicLibraryShelf from "../PublicLibraryShelf";
import { getAllBooks } from "../../../pages/library/books/booksService";

jest.mock("react-router-dom", () => ({ useNavigate: () => jest.fn() }), { virtual: true });
jest.mock("../../../pages/library/books/booksService", () => ({
  getAllBooks: jest.fn(),
}));

test("shows only zero-price books, regardless of tier badge — price is the real gate, tier is decorative", async () => {
  getAllBooks.mockResolvedValue([
    { slug: "free-story", title: "A Free Story", price: 0, tier: "standard" },
    { slug: "priced-book", title: "A Priced Book", price: 200, tier: "free" },
    { slug: "free-premium-badge", title: "Free But Premium Badge", price: 0, tier: "premium" },
  ]);
  render(<PublicLibraryShelf />);
  await waitFor(() => expect(screen.getByTestId("public-library-shelf")).toBeInTheDocument());
  expect(screen.getByText("A Free Story")).toBeInTheDocument();
  expect(screen.getByText("Free But Premium Badge")).toBeInTheDocument();
  expect(screen.queryByText("A Priced Book")).not.toBeInTheDocument();
});

test("empty state renders honestly when there are no zero-price books — no fake content", async () => {
  getAllBooks.mockResolvedValue([
    { slug: "priced-only", title: "Only A Priced Book", price: 50, tier: "free" },
  ]);
  render(<PublicLibraryShelf />);
  await waitFor(() => expect(screen.getByTestId("public-library-shelf-empty")).toBeInTheDocument());
  expect(screen.queryByText("Only A Priced Book")).not.toBeInTheDocument();
});

test("a failed catalog fetch degrades to the honest empty state, never a crash", async () => {
  getAllBooks.mockRejectedValue(new Error("network down"));
  render(<PublicLibraryShelf />);
  await waitFor(() => expect(screen.getByTestId("public-library-shelf-empty")).toBeInTheDocument());
});

test("books missing a slug are excluded (nothing to navigate to)", async () => {
  getAllBooks.mockResolvedValue([
    { title: "No Slug Here", price: 0 },
    { slug: "has-slug", title: "Has A Slug", price: 0 },
  ]);
  render(<PublicLibraryShelf />);
  await waitFor(() => expect(screen.getByTestId("public-library-shelf")).toBeInTheDocument());
  expect(screen.getByText("Has A Slug")).toBeInTheDocument();
  expect(screen.queryByText("No Slug Here")).not.toBeInTheDocument();
});
