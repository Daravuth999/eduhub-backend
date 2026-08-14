/**
 * booksServiceCacheOwnership.test.js — regression proof for the P0 "0/1
 * pages" incident's actual root cause.
 *
 * Root cause chain (verified against BOTH sides of the wire this session):
 *   1. ORIGIN — fetchBooksFromBackend() sent /api/books with
 *      `credentials:"include"` only. eduhub-backend's own current_student
 *      dependency (server.py) is documented and implemented as "cookie
 *      first, Bearer fallback (Safari ITP)" and /api/books depends on it —
 *      the backend already expects this header; this one frontend call
 *      site never sent it. On any device where the cookie doesn't reach
 *      the backend, an authenticated request was silently treated as a
 *      guest, and guest_content_boundary.py CORRECTLY (by its own design)
 *      stripped chapters/content from every priced book in the response.
 *   2. AMPLIFIER — saveCache()/loadCacheEntry() used ONE localStorage key
 *      shared by every caller regardless of auth state. A guest's
 *      correctly-stripped response and an authenticated student's full
 *      response landed in the same slot, so whichever fetch wrote last
 *      decided what every reader on that device saw — and because the
 *      poisoned entry lives in the browser (not the deployed frontend
 *      bundle), a Vercel rollback could never fix it.
 *
 * This file proves both repairs, using this codebase's established
 * `global.fetch = jest.fn()` mocking convention (see
 * statusEnforcerActiveSessionDefer.test.jsx / bookFactoryStudio.test.jsx
 * for the same pattern).
 */

const STUDENT_TOKEN_KEY = "student_session_token";
const BACKEND_URL = "https://example-backend.test";

let booksService;

function freshBackendResponse(books) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, books }),
  };
}

beforeEach(() => {
  jest.resetModules();
  localStorage.clear();
  process.env.REACT_APP_BACKEND_URL = BACKEND_URL;
  process.env.REACT_APP_BOOKS_SHEET_ID = "";
  // Static catalog + sheet are both irrelevant to this test — make every
  // fetch except the one to /api/books resolve to a harmless 404 so
  // fetchFreshCatalog's Promise.all doesn't hang on unmocked paths.
  global.fetch = jest.fn((url) => {
    if (String(url).includes("/api/books")) {
      return Promise.reject(new Error("unset in this test — override me"));
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
  booksService = require("../booksService");
});

afterEach(() => {
  jest.resetModules();
});

test("ORIGIN FIX: fetchBooksFromBackend attaches Authorization: Bearer when a student token exists — matching eduhub-backend's current_student cookie-first-Bearer-fallback contract", async () => {
  localStorage.setItem(STUDENT_TOKEN_KEY, "tok_abc123");
  let capturedInit = null;
  global.fetch = jest.fn((url, init) => {
    if (String(url).includes("/api/books")) {
      capturedInit = init;
      return Promise.resolve(freshBackendResponse([
        { slug: "free-book", price: 0, published: true, format: "blocks", chapters: [{ title: "1", blocks: [{ type: "paragraph", text: "hi" }] }] },
      ]));
    }
    return Promise.resolve({ ok: false, status: 404 });
  });

  await booksService.getAllBooks({ isAuthenticated: true });

  expect(capturedInit).not.toBeNull();
  expect(capturedInit.headers).toEqual(expect.objectContaining({ Authorization: "Bearer tok_abc123" }));
  expect(capturedInit.credentials).toBe("include"); // additive, not a replacement for the cookie path
});

test("ORIGIN FIX: no Authorization header is sent when there is no student token (genuine guest)", async () => {
  let capturedInit = null;
  global.fetch = jest.fn((url, init) => {
    if (String(url).includes("/api/books")) {
      capturedInit = init;
      return Promise.resolve(freshBackendResponse([]));
    }
    return Promise.resolve({ ok: false, status: 404 });
  });

  await booksService.getAllBooks({ isAuthenticated: false });

  expect(capturedInit).not.toBeNull();
  expect(capturedInit.headers).not.toHaveProperty("Authorization");
});

test("AMPLIFIER FIX: a guest fetch and an authenticated fetch never occupy the same localStorage slot", async () => {
  global.fetch = jest.fn((url) => {
    if (String(url).includes("/api/books")) {
      return Promise.resolve(freshBackendResponse([
        { slug: "priced-book", price: 30, published: true, format: "blocks", chapters: [{ title: "1", blocks: [{ type: "paragraph", text: "real content" }] }] },
      ]));
    }
    return Promise.resolve({ ok: false, status: 404 });
  });

  await booksService.getAllBooks({ isAuthenticated: true });

  const keysAfterAuth = Object.keys(localStorage.__STORE__ || {});
  // jsdom's localStorage doesn't expose __STORE__ publicly in all versions —
  // fall back to scanning via the standard API either way.
  const allKeys = [];
  for (let i = 0; i < localStorage.length; i++) allKeys.push(localStorage.key(i));
  const authKey = allKeys.find((k) => k.includes("eduhub_books_cache_v3") && k.includes(":auth:"));
  const guestKey = allKeys.find((k) => k.includes("eduhub_books_cache_v3") && k.includes(":guest:"));

  expect(authKey).toBeTruthy();
  expect(guestKey).toBeFalsy(); // nothing guest-scoped was ever written
  void keysAfterAuth;
});

test("REPRODUCTION: a guest's correctly-stripped response can no longer poison what an authenticated reader sees", async () => {
  // Step 1 — guest loads the Library (no token, per guest_content_boundary
  // this book legitimately arrives with chapters removed since price > 0).
  global.fetch = jest.fn((url) => {
    if (String(url).includes("/api/books")) {
      return Promise.resolve(freshBackendResponse([
        { slug: "the-clockmakers-last-wish", price: 30, published: true, tier: "standard" }, // chapters/content stripped by the backend boundary
      ]));
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
  await booksService.getAllBooks({ isAuthenticated: false });
  const guestCopy = await booksService.getBookBySlug("the-clockmakers-last-wish", { isAuthenticated: false });
  expect(guestCopy.chapters).toEqual([]); // correct guest behavior — not the bug

  // Step 2 — an authenticated student opens the same book. Even though the
  // guest write above happened first (and even reuses the SAME mocked
  // fetch queue), the authenticated read must go through its OWN cache
  // namespace and its OWN network call — never read the guest's entry.
  global.fetch = jest.fn((url) => {
    if (String(url).includes("/api/books")) {
      return Promise.resolve(freshBackendResponse([
        {
          slug: "the-clockmakers-last-wish",
          price: 30,
          published: true,
          tier: "standard",
          format: "blocks",
          chapters: [{ title: "Chapter 1", blocks: [{ type: "paragraph", text: "The clockmaker opened his shop." }] }],
        },
      ]));
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
  const studentCopy = await booksService.getBookBySlug("the-clockmakers-last-wish", { isAuthenticated: true });

  expect(studentCopy.chapters.length).toBeGreaterThan(0); // the fix: never 0/1 for an authenticated, entitled read
});

test("Cache ownership: a concurrent guest fetch and authenticated fetch don't dedupe into ONE shared in-flight request, and each persists to its own namespace", async () => {
  let fetchCount = 0;
  global.fetch = jest.fn((url) => {
    if (String(url).includes("/api/books")) {
      fetchCount += 1;
      return Promise.resolve(freshBackendResponse([
        { slug: "x", price: 0, published: true, format: "blocks", chapters: [{ title: "1", blocks: [{ type: "paragraph", text: "content" }] }] },
      ]));
    }
    return Promise.resolve({ ok: false, status: 404 });
  });

  await Promise.all([
    booksService.getAllBooks({ isAuthenticated: false }),
    booksService.getAllBooks({ isAuthenticated: true }),
  ]);

  // Two independent scopes must not share the module-level in-flight dedup
  // gate — each made its own network pass (3 sources each = up to 6 total
  // /api/books-matching calls; the important invariant is BOTH scopes
  // actually reached the network rather than one silently inheriting the
  // other's promise).
  expect(fetchCount).toBeGreaterThanOrEqual(2);

  const allKeys = [];
  for (let i = 0; i < localStorage.length; i++) allKeys.push(localStorage.key(i));
  expect(allKeys.some((k) => k.includes(":auth:"))).toBe(true);
  expect(allKeys.some((k) => k.includes(":guest:"))).toBe(true);
});
