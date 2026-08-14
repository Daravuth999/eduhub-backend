// LibraryPage.jsx — full /library page; merged from classroom-library/Dashboard.jsx
//   and App.jsx. Uses unified AuthContext so the library shares the same login.
//   Bookshelves are PUBLIC, and reachable by guests (see GuestAwareGate in
//   App.js) — tapping any book navigates straight into the Reader for
//   everyone. The backend's guest content boundary + ReaderPage's own
//   guestLocked branch decide how much of a non-free-tier book a guest can
//   actually see; this page never redirects a guest to /login.
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { Flame, Gem, BookOpen, Sparkles, ArrowLeft, LogIn, RefreshCw, Wallet } from "lucide-react";
// v14 — premium interactive greeter (theme-aware, GPU-cheap)
import { formatPoints } from "../../lib/formatPoints";
import LibraryLottieGreeter from "../../components/LibraryLottieGreeter.jsx";
import StatCard from "./components/StatCard.jsx";
import LevelBar from "./components/LevelBar.jsx";
import DailyQuestBanner from "./components/DailyQuestBanner.jsx";
import Bookshelf from "./components/Bookshelf.jsx";
import PurchaseModal from "./components/PurchaseModal.jsx";
import VoucherBanner from "./components/VoucherBanner.jsx";
import PointsToast from "./components/PointsToast.jsx";
import RestrictionOverlay from "./components/RestrictionOverlay.jsx";
import LibrarySearch from "./components/LibrarySearch.jsx";
import ContinueReading from "./components/ContinueReading.jsx";
import LibraryTopUpButton from "../../components/LibraryTopUpButton.jsx";
import { SECTION_ORDER, SECTION_META, isItemNew } from "./sections.js";
import { getContent, getStudentStats } from "./api.js";
import { getAllBooks, mergeCatalogIntoShelves } from "./books/booksService";
import {
  isUnlocked,
  availableBalance,
  purchaseBook,
} from "./books/purchaseService";
import { useAuth } from "../../context/AuthContext";
// Artwork Campaign System v1.0 — Library placements (hero / featured / shelf)
import ArtworkCarousel from "../../components/artwork/ArtworkCarousel";
import ArtworkFeaturedCard from "../../components/artwork/ArtworkFeaturedCard";
import ArtworkShelfCard from "../../components/artwork/ArtworkShelfCard";
import { onPointsUpdated } from "../../utils/pointsSync";
import "./library-theme.css";
import "./library-cinematic.css"; /* v10 — cinematic dark-mode overlay */
import "./library-visibility.css"; /* v15 — day/night contrast + premium polish */
import "./library-premium-v2.css"; /* v16 — premium ivory "Classroom Library" skin (append-only, scoped to [data-testid=library-page]) */
import "./library-premium-adaptive.css"; /* v17 — smart adaptive day/night polish for greeter/stats/level/quest/continue/books */

export default function LibraryPage() {
  const { isAuthenticated, student, logout, refreshPoints, setBalance } = useAuth();
  const navigate = useNavigate();

  const [stats, setStats] = useState(null);
  const [content, setContent] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [loadingContent, setLoadingContent] = useState(false);
  const [purchasePending, setPurchasePending] = useState(null);
  const [toast, setToast] = useState(null);
  const [restricted, setRestricted] = useState(false);
  const [restrictionMsg, setRestrictionMsg] = useState("");
  const [ownershipTick, setOwnershipTick] = useState(0); // bump to refresh card badges
  // v7.9 — library search query (live)
  const [searchQuery, setSearchQuery] = useState("");
  // v7.9.1 — library filter chips (All / New / A1 / A2 / B1)
  const [activeFilter, setActiveFilter] = useState("all");
  // v15.1 — Library view-mode: "discover" (default — owned hidden from
  // category shelves), "owned" (only owned in shelves), "all" (legacy
  // behaviour — owned mixed in). Independent of `activeFilter` so the
  // existing chip filters still combine with whichever view is active.
  // Search ALWAYS overrides view-mode so students can find owned books.
  const [viewMode, setViewMode] = useState("discover");

  // Apply the dark-academia theme to body while on /library
  useEffect(() => {
    document.body.setAttribute("data-library-theme", "true");
    return () => document.body.removeAttribute("data-library-theme");
  }, []);

  // Honour AuthContext restriction flags from the portal Apps Script
  useEffect(() => {
    const r = student?.portalData?.Restriction;
    if (r && String(r).toUpperCase() === "TRUE") {
      setRestricted(true);
      setRestrictionMsg(
        student?.portalData?.RestrictionMessage ||
          "Your account has been restricted. Please contact support.",
      );
    } else {
      setRestricted(false);
    }
  }, [student]);

  const loadStats = useCallback(async (id) => {
    if (!id) return;
    try {
      const data = await getStudentStats(id);
      if (data?.success) {
        setStats({
          completedLessons: Number(data.completedLessons) || 0,
          currentStreak: Number(data.currentStreak) || 0,
          totalPoints: Number(data.totalPoints) || 0,
          level: Number(data.level) || 1,
          XP: Number(data.XP) || 0,
        });
      }
    } catch (e) {
      console.error("library stats error", e);
    }
  }, []);

  const loadContent = useCallback(async (opts = {}) => {
    setLoadingContent(true);
    try {
      const [data, cat] = await Promise.all([
        getContent().catch(() => null),
        getAllBooks({ forceRefresh: !!opts.forceRefresh, isAuthenticated }).catch(() => []),
      ]);
      const legacy =
        data?.success && data.content
          ? data.content
          : { story: [], conversation: [], exercise: [] };
      const merged = mergeCatalogIntoShelves(legacy, cat || []);
      setCatalog(cat || []);
      setContent(merged);
    } catch (e) {
      console.error("library content error", e);
      setContent({ story: [], conversation: [], exercise: [] });
    } finally {
      setLoadingContent(false);
    }
  }, [isAuthenticated]);

  // First-load: always fetch the public content; fetch personal stats only when authed.
  useEffect(() => { loadContent(); }, [loadContent]);
  useEffect(() => {
    if (isAuthenticated && student?.studentId) {
      loadStats(student.studentId);
      // Pull the freshest real points balance from the backend
      refreshPoints?.();
    }
    else setStats(null);
  }, [isAuthenticated, student?.studentId, loadStats, refreshPoints]);

  // Points-sync v1 — listen for known-balance broadcasts (Send Points,
  // EduTalk charges, top-up success). When one arrives we ALSO trigger a
  // server reconcile so the Library wallet pill and stats always reflect
  // server truth and never drift. RealtimeSyncBridge already handles the
  // refresh-requested signal; this is a defensive secondary path so the
  // Library re-renders against the freshest AuthContext snapshot even if
  // the user is parked on the Library tab.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    return onPointsUpdated(() => {
      try { refreshPoints?.(); } catch { /* refreshPoints handles its own errors */ }
    });
  }, [isAuthenticated, refreshPoints]);

  const portalPoints = Number(student?.portalPoints || student?.points || 0);
  const balance = availableBalance(student?.studentId, portalPoints, catalog);

  const handleStartLesson = useCallback(
    async (item, sectionKey) => {
      // v7.9.1 — Library is strictly in-app now (no external-redirect books).
      if (!item?.inAppSlug) return;
      // Guest reading experience — a guest has no login, no wallet, and no
      // purchases, so neither the login-redirect nor the points-purchase
      // flow below applies to them. They always go straight into the
      // Reader; the backend's guest content boundary + ReaderPage's own
      // guestLocked branch are what actually decide how much of a
      // non-free-tier book they can see, exactly like tapping any other
      // book slug. Every authenticated-student behavior below (purchase
      // check included) is completely unchanged.
      if (!isAuthenticated) {
        navigate(`/library/read/${item.inAppSlug}`);
        return;
      }
      const book = item._book;
      const needsPurchase =
        book && Number(book.price) > 0 && !isUnlocked(student?.studentId, book, student?.portalData);
      if (needsPurchase) {
        setPurchasePending({ item, sectionKey, book });
        return;
      }
      navigate(`/library/read/${item.inAppSlug}`);
    },
    [isAuthenticated, student?.studentId, navigate, student?.portalData],
  );

  const [purchaseError, setPurchaseError] = useState(null);
  const [purchaseDone, setPurchaseDone] = useState(null); // holds { item } while modal plays unlock animation

  const confirmPurchase = useCallback(async (appliedCouponCode = null, discountedPrice = null) => {
    if (!purchasePending) return;
    const { item, book } = purchasePending;
    setPurchaseError(null);
    const effectiveBookPrice = (discountedPrice !== null && discountedPrice >= 0) ? discountedPrice : Number(book.price) || 0;
    // A voucher/coupon MUST be redeemed on the backend BEFORE we unlock at the
    // discounted price. The backend coupon flow is the source of truth: a
    // failed or non-OK redeem ABORTS the purchase. We never grant a discounted
    // unlock without a confirmed redemption. (No-coupon purchases skip this
    // block entirely and proceed normally.)
    if (appliedCouponCode && discountedPrice !== null) {
      const BACKEND_URL =
        (typeof process !== "undefined" && process.env?.REACT_APP_BACKEND_URL) ||
        "https://eduhub-backend-td3a.onrender.com";
      const sid = String(student?.studentId || "").trim();
      const FRIENDLY = "Voucher could not be redeemed. Please try again or remove the voucher.";
      let redeemRes;
      try {
        redeemRes = await fetch(`${BACKEND_URL}/api/coupons/redeem`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: appliedCouponCode, book_slug: book.slug, original_price: Number(book.price) || 0, student_id: sid }),
        });
      } catch {
        // Network/transport failure — do NOT proceed to purchase.
        setPurchaseError(FRIENDLY);
        throw new Error(FRIENDLY);
      }
      const redeemData = await redeemRes.json().catch(() => ({}));
      if (!redeemRes.ok || redeemData?.success === false) {
        const msg = redeemData?.detail || redeemData?.message || FRIENDLY;
        setPurchaseError(msg);
        throw new Error(msg);
      }
    }
    // Reached only when there is NO coupon, OR the coupon redeemed successfully.
    const res = await purchaseBook({
      studentId: student?.studentId,
      password: student?.password,
      book: { ...book, price: effectiveBookPrice },
      portalPoints,
    });
    if (res?.success) {
      // 1) Directly prime the unlocks cache in localStorage immediately
      try {
        const CACHE_KEY = "eduhub_unlocks_cache_v1";
        const existing = localStorage.getItem(CACHE_KEY);
        const parsed = existing ? JSON.parse(existing) : { ts: Date.now(), byStudent: {} };
        const sid = String(student?.studentId || "").trim();
        parsed.byStudent = parsed.byStudent || {};
        parsed.byStudent[sid] = parsed.byStudent[sid] || [];
        if (!parsed.byStudent[sid].includes(book.slug)) {
          parsed.byStudent[sid].push(book.slug);
        }
        parsed.ts = Date.now();
        localStorage.setItem(CACHE_KEY, JSON.stringify(parsed));
      } catch { /* ignore */ }

      // 2) Also prime the local ledger with mode:'server' so isUnlocked() fallback works
      try {
        const LEDGER_KEY = "eduhub_lib_unlocks_" + String(student?.studentId || "guest");
        const existing = localStorage.getItem(LEDGER_KEY);
        const ledger = existing ? JSON.parse(existing) : [];
        const alreadyExists = ledger.some(e => e.slug === book.slug);
        if (!alreadyExists) {
          ledger.push({ slug: book.slug, price: book.price, unlockedAt: new Date().toISOString(), mode: "server" });
          localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
        }
      } catch { /* ignore */ }

      // 3) Bump tick to force re-render — now localStorage has the new entry
      setOwnershipTick((t) => t + 1);

      // 4) Update balance instantly
      if (typeof res.newBalance === "number") setBalance(res.newBalance);

      // 5) Reconcile with server
      refreshPoints?.();

      setPurchaseDone({ item });
    } else {
      setPurchaseError(res?.message || "Purchase failed. Please try again.");
      throw new Error(res?.message || "purchase failed");
    }
  }, [purchasePending, student?.studentId, student?.password, portalPoints, refreshPoints, setBalance]);

  const finishPurchase = useCallback(() => {
    const done = purchaseDone;
    setPurchaseDone(null);
    setPurchasePending(null);
    if (done?.item?.inAppSlug) navigate(`/library/read/${done.item.inAppSlug}`);
  }, [purchaseDone, navigate]);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const initials = (student?.name || "Reader")
    .split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();

  // v7.9 — derived search state. We compute totals + match counts +
  // top suggestions from the *flat catalog* (sheet) so search hits
  // every book regardless of which legacy shelf section it falls into.
  const totalBookCount = catalog.length;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchedBooks = useMemo(() => {
    if (!normalizedQuery) return catalog;
    return catalog.filter((b) => {
      const haystack = [
        b.title, b.subtitle, b.author, b.badge, b.level, b.section,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [catalog, normalizedQuery]);
  const matchedBookCount = matchedBooks.length;
  const searchSuggestions = normalizedQuery
    ? matchedBooks.slice(0, 6).map((b) => ({
        title: b.title,
        subtitle: b.subtitle,
        author: b.author,
        section: b.section,
        badge: b.badge,
        coverImage: b.coverImage,
        coverEmoji: b.coverEmoji,
        _book: b,
      }))
    : [];

  // Filter the rendered shelves when a search query is active so the
  // user only sees matching cards under each shelf header.
  const matchedSlugs = useMemo(
    () => new Set(matchedBooks.map((b) => b.slug)),
    [matchedBooks]
  );

  // ────────────────────────────────────────────────────────────────────
  // "New for You" rail — surgical, opt-in additive shelf
  // ────────────────────────────────────────────────────────────────────
  // Collect new books from EVERY category so the rail acts as a single
  // discovery shelf above the rest of the Library. Driven by the same
  // `isItemNew(item)` helper used by the per-shelf NEW pill, so a book
  // tagged "new" on the Books sheet shows up here automatically without
  // a backend change. Skipped entirely when:
  //   • there are no new items (rail simply doesn't render);
  //   • the user is searching (search results already filter by slug);
  //   • the active filter is "new" (the existing chip already does the
  //     equivalent at full per-shelf granularity).
  const newForYouItems = useMemo(() => {
    if (!content) return [];
    const seen = new Set();
    const out = [];
    for (const sectionKey of SECTION_ORDER) {
      const list = content[sectionKey] || [];
      for (const it of list) {
        if (!isItemNew(it)) continue;
        const id = it._book?.slug || it.inAppSlug || it.title;
        if (!id || seen.has(id)) continue;
        // Resolve ownership before deciding whether to include this item.
        const owned = it._book
          ? isUnlocked(student?.studentId, it._book, student?.portalData)
          : false;
        // "New for You" means new AND not yet owned. Owned books are
        // already visible in "My Books" — showing them here creates
        // confusing duplicates with the ownership tick in a discovery rail.
        if (owned) continue;
        seen.add(id);
        out.push({
          ...it,
          _isNew: true,
          _owned: false,          // always false here — owned items are skipped above
          _ownTick: ownershipTick,
          // Preserve the original section so BookCard styling stays correct.
          section: it.section || sectionKey,
        });
        if (out.length >= 16) break; // hard cap — keeps the rail snappy
      }
      if (out.length >= 16) break;
    }
    return out;
  }, [content, ownershipTick, student?.studentId, student?.portalData]);
  const showNewForYou =
    !!isAuthenticated &&
    !normalizedQuery &&
    activeFilter !== "new" &&
    newForYouItems.length > 0;
  const NEW_FOR_YOU_META = useMemo(() => ({
    key: "new_for_you",
    label: "New for You",
    khmer: "សៀវភៅថ្មីសម្រាប់អ្នក",
    emoji: "✨",
    gradient: "linear-gradient(155deg, #2A1B3A 0%, #4A2D6A 100%)",
    accent: "#FFE19A",
    iconType: "sparkles",
    section: "new_for_you",
  }), []);

  // ────────────────────────────────────────────────────────────────────
  // "My Books" rail — owned/unlocked books grouped above Discover
  // ────────────────────────────────────────────────────────────────────
  // Collects every book the student has unlocked (free, purchased, gifted,
  // tier-included, admin-granted) across ALL category sections so they
  // have ONE clear place to find what they own. Section metadata is
  // preserved so book-card styling and click-routing keep working through
  // the existing `handleStartLesson(item, key)` flow.
  //
  // Hidden when:
  //   • not authenticated (nothing to own),
  //   • the student has zero owned books,
  //   • the user is searching (search results already cross sections),
  //   • viewMode === "owned" (the Discover shelves below already show
  //     only owned books — repeating the rail would be redundant).
  const myBooksItems = useMemo(() => {
    if (!content || !isAuthenticated) return [];
    const seen = new Set();
    const out = [];
    for (const sectionKey of SECTION_ORDER) {
      const list = content[sectionKey] || [];
      for (const it of list) {
        const owned = it._book
          ? isUnlocked(student?.studentId, it._book, student?.portalData)
          : false;
        if (!owned) continue;
        const id = it._book?.slug || it.inAppSlug || it.title;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          ...it,
          _isNew: isItemNew(it),
          _owned: true,
          _ownTick: ownershipTick,
          section: it.section || sectionKey,
        });
      }
    }
    return out;
  }, [content, isAuthenticated, ownershipTick, student?.studentId, student?.portalData]);

  const showMyBooks =
    !!isAuthenticated &&
    !normalizedQuery &&
    viewMode !== "owned" &&
    myBooksItems.length > 0;

  const MY_BOOKS_META = useMemo(() => ({
    key: "my_books",
    label: "My Books",
    khmer: "សៀវភៅរបស់ខ្ញុំ",
    emoji: "📚",
    gradient: "linear-gradient(155deg, #1F2A3A 0%, #2E4258 100%)",
    accent: "#FFE19A",
    iconType: "book",
    section: "my_books",
  }), []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
      className="relative z-10 min-h-screen pb-12 lib-visibility-root"
      data-testid="library-page"
    >
      <main className="mx-auto max-w-[860px] px-1 sm:px-2 pt-2">
        {/* Reward-kind v1.0.2 — voucher-ready banner. Self-hides unless the
            student arrived with ?voucher=CODE. Guidance only; the discount
            is applied by the existing coupon flow in PurchaseModal. */}
        <VoucherBanner books={catalog} />

        {/* Greeting */}
        <section className="mb-5 mt-1 flex items-center gap-4" data-testid="library-greeting">
          <div
            className="grid h-14 w-14 place-items-center rounded-2xl border border-gold/30 font-display text-xl text-parchment"
            style={{
              background: "linear-gradient(150deg, #2D1F3E 0%, #1A1420 100%)",
              boxShadow: "inset 0 1px 0 rgba(212,168,67,0.18)",
            }}
          >
            {isAuthenticated ? initials : <BookOpen className="h-6 w-6 text-gold" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.2em] text-faded">Classroom Library</p>
            <h2 className="truncate font-display text-2xl text-parchment" data-testid="library-name">
              {isAuthenticated ? `Welcome back, ${(student?.name || "Reader").split(" ")[0]}` : "Your reading sanctuary"}
            </h2>
            {/* 3-bug-fix v2: removed the "Apprentice Reader" pill and the
                Khmer "សួស្តី! រៀនល្អ​ៗ​ណា" label because they visually
                collided with the Top Up button on iPhone widths.
                Top Up button, points pill, refresh button, avatar and
                name greeting are intentionally preserved. */}
          </div>
          {!isAuthenticated && (
            <Link
              to="/login?redirect=/library"
              data-testid="library-login-cta"
              className="hidden sm:inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider text-ink shadow-[0_8px_18px_rgba(212,168,67,0.45)]"
              style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}
            >
              <LogIn className="h-3.5 w-3.5" /> Sign in to track
            </Link>
          )}
          {isAuthenticated && (
            <LibraryTopUpButton
              studentId={student?.studentId}
              onCredited={() => {
                refreshPoints?.();
                loadStats();
              }}
            />
          )}
          {isAuthenticated && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              key={balance}
              transition={{ type: "spring", damping: 18 }}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[12px] font-bold"
              data-testid="wallet-pill"
              style={{
                background:
                  "linear-gradient(135deg, rgba(212,168,67,0.18), rgba(212,168,67,0.08))",
                border: "1px solid rgba(212,168,67,0.45)",
                color: "#FFE19A",
                boxShadow: "0 6px 14px rgba(212,168,67,0.18), inset 0 1px 0 rgba(255,255,255,0.05)",
                backdropFilter: "blur(8px)",
              }}
            >
              <Wallet className="h-3.5 w-3.5" />
              <span className="tabular">{balance}</span>
              <span className="text-[10px] font-semibold uppercase tracking-wider opacity-70">
                pts
              </span>
            </motion.div>
          )}
          <button
            onClick={() => loadContent({ forceRefresh: true })}
            title="Reload books from Google Sheet"
            data-testid="library-refresh-btn"
            disabled={loadingContent}
            className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-walnut/70 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingContent ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">{loadingContent ? "Syncing" : "Sync Sheet"}</span>
          </button>
        </section>

        {/* v14 — Premium interactive greeter (theme-aware, GPU-cheap, IO-paused) */}
        <LibraryLottieGreeter className="mb-4" />

        {/* Stats row — only for authed users */}
        {isAuthenticated && (
          <section className="grid grid-cols-3 gap-2.5">
            <StatCard
              icon={<BookOpen className="h-4 w-4" />}
              label="Lessons"
              khmer="មេរៀន"
              value={stats?.completedLessons ?? 0}
              tint="#7DA8E0"
              testid="stat-lessons"
            />
            <StatCard
              icon={<Flame className="h-4 w-4" />}
              label="Streak"
              khmer="ថ្ងៃ"
              value={stats?.currentStreak ?? 0}
              tint="#FFB14A"
              suffix="d"
              testid="stat-streak"
            />
            <StatCard
              icon={<Gem className="h-4 w-4" />}
              label="Points"
              khmer="ពិន្ទុ"
              value={formatPoints(stats?.totalPoints ?? 0)}
              tint="#00BFA5"
              testid="stat-points"
            />
          </section>
        )}

        {isAuthenticated && (
          <>
            <LevelBar level={stats?.level ?? 1} xp={stats?.XP ?? 0} />
            <DailyQuestBanner
              completed={stats?.completedLessons ?? 0}
              streak={stats?.currentStreak ?? 0}
            />
          </>
        )}

        {/* Artwork Campaign System v1.0 — Placement A: Library Hero.
            Directly below the Library statistics area. Swipeable carousel
            at native mobile proportion. Renders nothing when no Library
            Hero campaigns are live. */}
        <div className="mt-4" data-testid="library-artwork-hero">
          <ArtworkCarousel placement="library_hero" showCaption />
        </div>

        {/* Login nudge for guests */}
        {!isAuthenticated && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 rounded-2xl border border-gold/25 px-4 py-3 flex items-center gap-3"
            style={{ background: "linear-gradient(120deg, rgba(212,168,67,0.18), rgba(45,106,79,0.16))" }}
          >
            <Sparkles className="h-5 w-5 text-gold" />
            <div className="flex-1 min-w-0">
              <p className="font-display text-[15px] leading-tight text-parchment">
                Track your reading streak and earn points
              </p>
              <p className="khmer text-[11px] text-faded">សម្រាប់តាមដានការអាន និងពិន្ទុ</p>
            </div>
            <Link
              to="/login?redirect=/library"
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[11px] font-bold uppercase tracking-wider text-ink shadow-[0_8px_18px_rgba(212,168,67,0.4)]"
              style={{ background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)" }}
            >
              <LogIn className="h-3 w-3" /> Sign in
            </Link>
          </motion.div>
        )}

        {/* v7.9 — search bar + Continue Reading rail */}
        {/* v15.1 — Library structure reorganised:
              Continue Reading → My Books → Search → Filters
            so students see "what to resume" + "what I own" first, and
            only then move into search/discover. */}

        {isAuthenticated && !searchQuery && (
          <ContinueReading
            catalog={catalog}
            onResume={(b) => {
              if (b?.slug) navigate(`/library/read/${b.slug}`);
            }}
          />
        )}

        {/* Artwork Campaign System v1.0 — Placement B: Featured Collection.
            Between Continue Reading and My Books. Curated-recommendation
            card (21:9). Renders nothing when no campaign is live. */}
        {!searchQuery && <ArtworkFeaturedCard />}

        {showMyBooks && (
          <div data-testid="library-my-books" className="lib-my-books-rail mt-4">
            <Bookshelf
              meta={MY_BOOKS_META}
              items={myBooksItems}
              onCardClick={(item) => {
                if (item.inAppSlug) handleStartLesson(item, item.section || "story");
              }}
            />
          </div>
        )}

        <div className="mt-5 mb-2">
          <LibrarySearch
            query={searchQuery}
            onChange={setSearchQuery}
            totalCount={totalBookCount}
            matchCount={matchedBookCount}
            suggestions={searchSuggestions}
            onPickBook={(s) => {
              if (s?._book?.slug) navigate(`/library/read/${s._book.slug}`);
            }}
          />
        </div>

        {/* v7.9.1 — filter chips + live-data pill */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2" data-testid="library-filter-row">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* v15.1 — View-mode chip group. Independent of the legacy
                filter chips below so they can be COMBINED (e.g.
                Discover + A1, or Owned + Audio). Hidden for logged-out
                users since they have nothing owned. */}
            {isAuthenticated && (
              <div
                className="lib-viewmode-group flex items-center gap-1 mr-1 rounded-full p-0.5"
                role="tablist"
                aria-label="Library view mode"
                data-testid="library-viewmode-row"
              >
                {[
                  { key: "discover", label: "Discover" },
                  { key: "owned",    label: "Owned" },
                  { key: "all",      label: "All" },
                ].map((m) => {
                  const active = viewMode === m.key;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setViewMode(m.key)}
                      data-testid={`library-viewmode-${m.key}`}
                      className="rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] transition-all"
                      style={{
                        background: active
                          ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 60%, #9C7A2C 100%)"
                          : "transparent",
                        color: active ? "#1a1420" : "#F4E5C1",
                        border: active
                          ? "1px solid rgba(255,225,154,0.6)"
                          : "1px solid rgba(212,168,67,0.18)",
                        boxShadow: active
                          ? "0 4px 10px rgba(212,168,67,0.30), inset 0 1px 0 rgba(255,255,255,0.45)"
                          : "none",
                      }}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            )}
            {[
              { key: "all", label: "All" },
              { key: "new", label: "New" },
              { key: "audio", label: "Audio" },
              { key: "video", label: "Video" },
              { key: "text", label: "Text" },
              { key: "free", label: "Free" },
              { key: "standard", label: "Standard" },
              { key: "premium", label: "Premium" },
              { key: "limited", label: "Limited" },
              { key: "A1", label: "A1" },
              { key: "A2", label: "A2" },
              { key: "B1", label: "B1" },
            ].map((chip) => {
              const active = activeFilter === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => setActiveFilter(chip.key)}
                  data-testid={`library-filter-${chip.key}`}
                  className="rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] transition-all"
                  style={{
                    background: active
                      ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 60%, #9C7A2C 100%)"
                      : "rgba(45,31,62,0.65)",
                    color: active ? "#1a1420" : "#F4E5C1",
                    border: active
                      ? "1px solid rgba(255,225,154,0.6)"
                      : "1px solid rgba(212,168,67,0.25)",
                    boxShadow: active
                      ? "0 6px 14px rgba(212,168,67,0.35), inset 0 1px 0 rgba(255,255,255,0.45)"
                      : "none",
                  }}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em]"
            style={{
              background:
                "linear-gradient(135deg, rgba(0,191,165,0.18), rgba(0,191,165,0.06))",
              color: "#8CE6D6",
              border: "1px solid rgba(0,191,165,0.45)",
            }}
            data-testid="library-live-pill"
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: "#00E8C3",
                boxShadow: "0 0 8px #00E8C3",
              }}
            />
            Live · real data from Apps Script
          </span>
        </div>

        {/* Shelves */}
        <section className="mt-7 space-y-7" data-testid="library-shelves">
          {loadingContent && !content && <ShelvesSkeleton />}

          {content && !loadingContent && catalog.length === 0 && (
            <div
              data-testid="library-empty-state"
              className="rounded-2xl border border-dashed border-gold/30 px-6 py-10 text-center"
              style={{ background: "rgba(34,24,48,0.5)" }}
            >
              <BookOpen className="mx-auto h-8 w-8 text-gold/70" />
              <p className="mt-3 font-display text-[17px] text-parchment">
                Your Library is quiet for now
              </p>
              <p className="khmer mt-1 text-[11px] text-faded">
                បណ្ណាល័យមិនទាន់មានសៀវភៅ
              </p>
              <p className="mx-auto mt-3 max-w-md text-[12.5px] leading-relaxed text-faded">
                Books are pulled live from the instructor's Google Sheet. Ask
                your instructor to publish entries in the <code className="text-gold">Books</code> tab — they'll
                appear here within seconds.
              </p>
            </div>
          )}

          {/* v15 — "New for You" rail. Surfaces fresh books from every
              category so students discover what's new at a glance. Hidden
              when searching, when the "New" filter chip is already active,
              or when there are simply no new books. Category shelves below
              are untouched. */}
          {showNewForYou && (
            <div data-testid="library-new-for-you" className="lib-new-for-you-rail">
              <Bookshelf
                meta={NEW_FOR_YOU_META}
                items={newForYouItems}
                onCardClick={(item) => {
                  if (item.inAppSlug) handleStartLesson(item, item.section || "story");
                }}
              />
            </div>
          )}

          {content && catalog.length > 0 &&
            (() => {
              // Artwork Campaign System v1.0 — Placement C: Shelf Artwork
              // Card. Injects at most ONE artwork card per ~11 books, never
              // a large banner. Card matches book-card sizing.
              const shelfOut = [];
              let bookCount = 0;
              let injected = 0;
              SECTION_ORDER.forEach((key) => {
              const meta = SECTION_META[key];
              let items = (content[key] || []).map((it) => ({
                ...it,
                _isNew: isItemNew(it),
                _owned: it._book
                  ? isUnlocked(student?.studentId, it._book, student?.portalData)
                  : false,
                // touch ownershipTick so React re-renders after purchase
                _ownTick: ownershipTick,
              }));
              // v15.1 — Apply view-mode (Discover / Owned / All).
              // Search overrides view-mode so owned books remain findable.
              if (isAuthenticated && !normalizedQuery) {
                if (viewMode === "discover") {
                  // Default: hide owned books from category shelves so the
                  // marketplace surface is dedicated to new purchases. The
                  // "My Books" rail above already shows everything owned.
                  items = items.filter((it) => !it._owned);
                } else if (viewMode === "owned") {
                  items = items.filter((it) => it._owned);
                }
                // viewMode === "all" → legacy behaviour, no filtering
              }
              // v7.9.1 — apply filter chip
              if (activeFilter !== "all") {
                if (activeFilter === "new") {
                  items = items.filter((it) => it._isNew);
                } else if (activeFilter === "audio" || activeFilter === "video" || activeFilter === "text") {
                  items = items.filter(
                    (it) => (it._contentType || "text") === activeFilter
                  );
                } else if (
                  activeFilter === "free" ||
                  activeFilter === "standard" ||
                  activeFilter === "premium" ||
                  activeFilter === "limited"
                ) {
                  // v9.2 — tier filter
                  items = items.filter(
                    (it) => (it.tier || it._book?.tier || "free") === activeFilter
                  );
                } else {
                  const target = activeFilter.toUpperCase();
                  items = items.filter(
                    (it) => String(it._book?.level || "").toUpperCase() === target
                  );
                }
              }
              // v7.9 — when a search query is active, hide non-matching
              // shelves entirely and filter cards by matched slug.
              if (normalizedQuery) {
                items = items.filter(
                  (it) => it._book && matchedSlugs.has(it._book.slug)
                );
                if (items.length === 0) return;
              }
              // v15.1 — if Discover view yields an empty shelf after
              // hiding owned books, hide the entire shelf rather than
              // showing an empty section header (keeps the page short).
              if (
                isAuthenticated &&
                !normalizedQuery &&
                (viewMode === "discover" || viewMode === "owned") &&
                items.length === 0
              ) {
                return;
              }
              shelfOut.push(
                <Bookshelf
                  key={key}
                  meta={meta}
                  items={items}
                  onCardClick={(item) => {
                    // v7.9.1 — all remaining shelf items are in-app catalog
                    // books (redirect-only entries are filtered out).
                    if (item.inAppSlug) handleStartLesson(item, key);
                  }}
                />
              );
              // Inject a shelf artwork card after roughly every 11 books,
              // search disabled (keeps search results clean).
              bookCount += items.length;
              if (!normalizedQuery && bookCount >= 11 * (injected + 1)) {
                shelfOut.push(
                  <div
                    key={`artwork-shelf-${key}`}
                    className="flex items-start gap-3"
                    data-testid="library-shelf-artwork-row"
                  >
                    <ArtworkShelfCard index={injected} />
                  </div>
                );
                injected += 1;
              }
            });
            return shelfOut;
          })()}
        </section>

        <footer className="mt-12 flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.3em] text-faded">
          <Sparkles className="h-3 w-3 text-gold" />
          <span>Read deeply · Learn quietly</span>
          <Sparkles className="h-3 w-3 text-gold" />
        </footer>
      </main>

      {/* v7.9.1 — ConfirmModal removed; no more external-redirect books */}

      <AnimatePresence>
        {purchasePending && (
          <PurchaseModal
            book={purchasePending.book}
            meta={SECTION_META[purchasePending.sectionKey]}
            price={Number(purchasePending.book?.price) || 0}
            balance={balance}
            error={purchaseError}
            onCancel={() => { setPurchasePending(null); setPurchaseError(null); }}
            onConfirm={confirmPurchase}
            onFinished={finishPurchase}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && <PointsToast points={toast.points} />}
      </AnimatePresence>

      <AnimatePresence>
        {restricted && (
          <RestrictionOverlay message={restrictionMsg} onLogout={logout} />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function ShelvesSkeleton() {
  return (
    <div className="space-y-7" data-testid="library-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i}>
          <div className="mb-3 h-5 w-40 rounded skeleton-shimmer" />
          <div className="flex gap-3 overflow-hidden">
            {[0, 1, 2, 3].map((j) => (
              <div
                key={j}
                className="h-[220px] w-[150px] flex-none rounded-2xl skeleton-shimmer"
                style={{ animationDelay: `${j * 120}ms` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
