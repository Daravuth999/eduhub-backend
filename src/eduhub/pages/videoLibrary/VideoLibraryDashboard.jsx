/**
 * VideoLibraryDashboard.jsx — the Video Library's premium streaming-style
 * landing page: identity welcome header (avatar, name, EduHub Points, tier),
 * search, level tabs, sort, category chips, and marketplace rails —
 * Continue Learning, Recommended For You (watch-history affinity, computed
 * client-side from real progress/bookmarks — never fabricated), Featured,
 * Recently Watched, New Releases, My Lessons, Bookmarks, and one rail per
 * backend category. Data comes from a handful of composable endpoints and
 * is grouped client-side, matching this codebase's convention.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clapperboard, Sparkles, Search, X, Crown, ArrowDownWideNarrow } from "lucide-react";
import { listLessons, listContinueWatching, listBookmarks, listRecentlyWatched, listMyPurchases } from "./videoLibraryApi";
import LessonCard, { LessonCardSkeleton, CATEGORY_LABELS } from "./LessonCard";
import { useAuth } from "../../context/AuthContext";
import EduHubPointsPill from "../../components/points/EduHubPointsPill";
import VideoLibraryCouponCard from "./VideoLibraryCouponCard";
import "./videoLibrary.css";

const GOLD = "#D4A843";

const DIFFICULTY_TABS = [
  { key: "", label: "All" },
  { key: "beginner", label: "Beginner" },
  { key: "intermediate", label: "Intermediate" },
  { key: "advanced", label: "Advanced" },
];

const CATEGORY_ROWS = [
  { key: "storytelling", label: "Storytelling" },
  { key: "conversation", label: "Conversation Practice" },
  { key: "business", label: "Business English" },
  { key: "ielts", label: "IELTS Preparation" },
  { key: "pronunciation", label: "Pronunciation" },
  { key: "grammar", label: "Grammar" },
  { key: "vocabulary", label: "Vocabulary" },
  { key: "listening", label: "Listening" },
  { key: "speaking", label: "Speaking" },
];

const SORTS = [
  { key: "newest", label: "Newest" },
  { key: "title", label: "A – Z" },
  { key: "priceAsc", label: "Price ↑" },
  { key: "priceDesc", label: "Price ↓" },
  { key: "duration", label: "Shortest" },
];

function WelcomeHeader({ student, continueCount }) {
  const name = student?.name || student?.gameName || student?.display_name || "Learner";
  const rawPoints = student?.points ?? student?.portalPoints ?? student?.portalData?.Points ?? student?.gamePoints;
  const points = Number.isFinite(Number(rawPoints)) && rawPoints !== null && rawPoints !== undefined && rawPoints !== ""
    ? Number(rawPoints) : null;
  const tier = student?.tier || student?.portalData?.Tier || (student ? "Member" : null);
  const initials = String(name).split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  return (
    <div className="px-4 sm:px-6 pt-5 pb-6 mb-2 rounded-b-2xl vl-rise"
         style={{ background: "linear-gradient(135deg, rgba(212,168,67,0.16), rgba(0,0,0,0) 70%)" }}
         data-testid="video-library-welcome">
      <div className="flex items-center gap-2 mb-3">
        <Clapperboard size={18} style={{ color: GOLD }} />
        <span className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: GOLD }}>
          Video Library
        </span>
      </div>
      <div className="flex items-center gap-3.5">
        <div className="w-12 h-12 rounded-full flex items-center justify-center text-[15px] font-bold flex-shrink-0"
             data-testid="video-library-avatar"
             style={{ background: "rgba(212,168,67,0.18)", border: "1.5px solid rgba(212,168,67,0.45)", color: GOLD }}>
          {student?.avatar_url
            ? <img src={student.avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
            : initials || "?"}
        </div>
        <div className="min-w-0">
          <h1 className="text-lg sm:text-xl font-bold text-ink dark:text-white leading-tight truncate"
              data-testid="video-library-student-name">
            Welcome back, {name}
          </h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {points !== null && (
              <EduHubPointsPill value={points} size="sm" testId="video-library-points-badge" />
            )}
            {tier && (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-zinc-600 dark:text-white/60"
                    data-testid="video-library-tier-badge">
                <Crown size={10} style={{ color: GOLD }} /> {tier}
              </span>
            )}
            {continueCount > 0 && (
              <span className="text-[11px] text-zinc-500 dark:text-white/50 inline-flex items-center gap-1">
                <Sparkles size={10} style={{ color: GOLD }} /> {continueCount} lesson{continueCount > 1 ? "s" : ""} in progress
              </span>
            )}
            <VideoLibraryCouponCard />
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ title, lessons, progressByLesson, onOpen, testId, index = 0 }) {
  if (!lessons || lessons.length === 0) return null;
  return (
    <section className="space-y-2.5 vl-rise" style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }} data-testid={testId}>
      <h2 className="text-[13px] font-bold uppercase tracking-wide text-zinc-500 dark:text-white/50 px-4 sm:px-6">
        {title}
      </h2>
      <div className="flex gap-3 overflow-x-auto px-4 sm:px-6 pb-1 vl-row-scroll">
        {lessons.map((lesson) => (
          <LessonCard key={lesson.lessonId} lesson={lesson}
                      progressFraction={progressByLesson[lesson.lessonId]} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-7" data-testid="video-library-skeleton">
      {[0, 1].map((r) => (
        <section key={r} className="space-y-2.5">
          <div className="h-3.5 w-40 rounded vl-skeleton mx-4 sm:mx-6" />
          <div className="flex gap-3 overflow-hidden px-4 sm:px-6">
            {[0, 1, 2, 3, 4].map((i) => <LessonCardSkeleton key={i} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Recommended For You — affinity from what the student actually watched /
 * bookmarked (categories + difficulties), scoring unwatched lessons. Pure
 * client-side heuristic over real signals; empty history ⇒ hidden row. */
function computeRecommended(lessons, progress, bookmarks) {
  const seen = new Set([...progress.map((p) => p.lessonId), ...bookmarks.map((b) => b.lessonId)]);
  if (seen.size === 0) return [];
  const byId = Object.fromEntries(lessons.map((l) => [l.lessonId, l]));
  const catScore = {}; const diffScore = {};
  for (const id of seen) {
    const l = byId[id];
    if (!l) continue;
    if (l.category) catScore[l.category] = (catScore[l.category] || 0) + 1;
    if (l.difficulty) diffScore[l.difficulty] = (diffScore[l.difficulty] || 0) + 1;
  }
  return lessons
    .filter((l) => !seen.has(l.lessonId))
    .map((l) => ({ l, score: (catScore[l.category] || 0) * 2 + (diffScore[l.difficulty] || 0) + (l.featured ? 0.5 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((x) => x.l);
}

export default function VideoLibraryDashboard() {
  const navigate = useNavigate();
  // Optional auth context — the dashboard renders a graceful anonymous
  // header when mounted outside <AuthProvider> (component tests, previews).
  let student = null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  try { student = useAuth().student; } catch { /* no provider */ }
  const [lessons, setLessons] = useState([]);
  const [continueWatching, setContinueWatching] = useState([]);
  const [recentlyWatched, setRecentlyWatched] = useState([]);
  const [myPurchases, setMyPurchases] = useState([]);
  const [bookmarks, setBookmarks] = useState([]);
  const [difficulty, setDifficulty] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [sort, setSort] = useState("newest");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);

  const load = useCallback(async (diff, q) => {
    setError(null);
    try {
      const [lessonList, progressList, recentList, purchaseList, bookmarkList] = await Promise.all([
        listLessons({ ...(diff ? { difficulty: diff } : {}), ...(q ? { q } : {}) }),
        listContinueWatching(),
        listRecentlyWatched(),
        listMyPurchases(),
        listBookmarks(),
      ]);
      setLessons(lessonList);
      setContinueWatching(progressList);
      setRecentlyWatched(recentList);
      setMyPurchases(purchaseList);
      setBookmarks(bookmarkList);
    } catch (e) {
      setError(e.message || "Could not load the Video Library.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(difficulty, query.trim()), query ? 350 : 0);
    return () => clearTimeout(debounceRef.current);
  }, [difficulty, query, load]);

  const sortedLessons = useMemo(() => {
    const base = categoryFilter ? lessons.filter((l) => l.category === categoryFilter) : lessons;
    const out = [...base];
    if (sort === "title") out.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    else if (sort === "priceAsc") out.sort((a, b) => (a.price || 0) - (b.price || 0));
    else if (sort === "priceDesc") out.sort((a, b) => (b.price || 0) - (a.price || 0));
    else if (sort === "duration") out.sort((a, b) => (a.durationSec || 0) - (b.durationSec || 0));
    else out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return out;
  }, [lessons, categoryFilter, sort]);

  const progressByLesson = useMemo(() => {
    const out = {};
    for (const p of continueWatching) {
      if (p.durationSec > 0) out[p.lessonId] = p.positionSec / p.durationSec;
    }
    return out;
  }, [continueWatching]);

  const lessonsById = useMemo(() => {
    const out = {};
    for (const l of lessons) out[l.lessonId] = l;
    return out;
  }, [lessons]);

  const continueWatchingLessons = useMemo(
    () => continueWatching.map((p) => lessonsById[p.lessonId]).filter(Boolean),
    [continueWatching, lessonsById],
  );
  const recentlyWatchedLessons = useMemo(
    () => recentlyWatched.map((p) => lessonsById[p.lessonId]).filter(Boolean).slice(0, 12),
    [recentlyWatched, lessonsById],
  );
  const bookmarkedLessons = useMemo(
    () => bookmarks.map((b) => lessonsById[b.lessonId]).filter(Boolean),
    [bookmarks, lessonsById],
  );
  const myPurchasedLessons = useMemo(
    () => myPurchases.filter((p) => p.state === "succeeded").map((p) => lessonsById[p.lessonId]).filter(Boolean),
    [myPurchases, lessonsById],
  );
  const recommended = useMemo(
    () => computeRecommended(sortedLessons, recentlyWatched, bookmarks),
    [sortedLessons, recentlyWatched, bookmarks],
  );
  const featured = useMemo(() => sortedLessons.filter((l) => l.featured), [sortedLessons]);
  const newReleases = useMemo(
    () => [...sortedLessons].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 10),
    [sortedLessons],
  );

  const openLesson = (lesson) => navigate(`/video-library/watch/${lesson.lessonId}`);
  const isFilteredView = Boolean(categoryFilter || query.trim());
  let rowIdx = 0;

  return (
    <div className="pb-10" data-testid="video-library-dashboard">
      <WelcomeHeader student={student} continueCount={continueWatchingLessons.length} />

      {/* Search + sort */}
      <div className="px-4 sm:px-6 mb-3 flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-white/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search lessons, vocabulary, expressions…"
            data-testid="video-library-search-input"
            className="w-full rounded-full border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 pl-9 pr-9 py-2 text-[13px] text-ink dark:text-white placeholder:text-zinc-400 dark:placeholder:text-white/35 focus:outline-none focus:border-[rgba(212,168,67,0.5)] transition-colors"
          />
          {query && (
            <button onClick={() => setQuery("")} data-testid="video-library-search-clear"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-white/40">
              <X size={13} />
            </button>
          )}
        </div>
        <div className="relative flex-shrink-0">
          <ArrowDownWideNarrow size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-zinc-400 dark:text-white/40" />
          <select value={sort} onChange={(e) => setSort(e.target.value)}
                  data-testid="video-library-sort-select"
                  className="appearance-none rounded-full border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 pl-8 pr-4 py-2 text-[12px] font-semibold text-ink dark:text-white/80 focus:outline-none">
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
      </div>

      {/* Level tabs */}
      <div className="flex gap-2 px-4 sm:px-6 mb-2.5 overflow-x-auto vl-row-scroll">
        {DIFFICULTY_TABS.map((tab) => (
          <button
            key={tab.key || "all"}
            onClick={() => setDifficulty(tab.key)}
            data-testid={`video-library-difficulty-tab-${tab.key || "all"}`}
            className="vl-chip px-3 py-1.5 rounded-full text-[12px] font-semibold whitespace-nowrap"
            style={difficulty === tab.key
              ? { background: "rgba(212,168,67,0.16)", color: GOLD, border: "1px solid rgba(212,168,67,0.35)" }
              : { background: "rgba(255,255,255,0.05)", color: "inherit", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Category chips */}
      <div className="flex gap-2 px-4 sm:px-6 mb-5 overflow-x-auto vl-row-scroll">
        <button onClick={() => setCategoryFilter("")}
                data-testid="video-library-category-chip-all"
                className="vl-chip px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap"
                style={!categoryFilter
                  ? { background: "rgba(212,168,67,0.16)", color: GOLD, border: "1px solid rgba(212,168,67,0.35)" }
                  : { background: "rgba(255,255,255,0.04)", color: "inherit", border: "1px solid rgba(255,255,255,0.08)" }}>
          All topics
        </button>
        {CATEGORY_ROWS.map((c) => (
          <button key={c.key} onClick={() => setCategoryFilter(categoryFilter === c.key ? "" : c.key)}
                  data-testid={`video-library-category-chip-${c.key}`}
                  className="vl-chip px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap"
                  style={categoryFilter === c.key
                    ? { background: "rgba(212,168,67,0.16)", color: GOLD, border: "1px solid rgba(212,168,67,0.35)" }
                    : { background: "rgba(255,255,255,0.04)", color: "inherit", border: "1px solid rgba(255,255,255,0.08)" }}>
            {CATEGORY_LABELS[c.key]}
          </button>
        ))}
      </div>

      {error && (
        <div className="mx-4 sm:mx-6 mb-4 text-[13px] text-red-400" data-testid="video-library-error">
          {error}
        </div>
      )}

      {loading ? (
        <SkeletonRows />
      ) : sortedLessons.length === 0 ? (
        <div className="mx-4 sm:mx-6 rounded-xl border border-dashed border-white/10 p-8 text-center vl-rise">
          <div className="w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center"
               style={{ background: "rgba(212,168,67,0.10)" }}>
            <Clapperboard size={20} style={{ color: GOLD }} />
          </div>
          <div className="text-[14px] font-semibold text-ink dark:text-white mb-1">
            {query.trim() ? "No lessons match your search" : categoryFilter ? "No lessons match" : "No lessons published yet"}
          </div>
          <div className="text-[12.5px] text-zinc-500 dark:text-white/50">
            {isFilteredView ? "Try a different word, level, or topic." : "Check back soon — new video lessons are added regularly."}
          </div>
        </div>
      ) : isFilteredView ? (
        /* Filtered/search view: one flat grid, sorted */
        <div className="px-4 sm:px-6 vl-rise">
          <div className="text-[12px] text-zinc-500 dark:text-white/50 mb-3" data-testid="video-library-results-count">
            {sortedLessons.length} lesson{sortedLessons.length > 1 ? "s" : ""}
            {categoryFilter ? ` in ${CATEGORY_LABELS[categoryFilter]}` : ""}
          </div>
          <div className="flex flex-wrap gap-3" data-testid="video-library-filtered-grid">
            {sortedLessons.map((lesson) => (
              <LessonCard key={lesson.lessonId} lesson={lesson}
                          progressFraction={progressByLesson[lesson.lessonId]} onOpen={openLesson} />
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-7">
          <Row title="Continue Learning" lessons={continueWatchingLessons} progressByLesson={progressByLesson} onOpen={openLesson} testId="video-library-row-continue" index={rowIdx++} />
          <Row title="Recommended For You" lessons={recommended} progressByLesson={progressByLesson} onOpen={openLesson} testId="video-library-row-recommended" index={rowIdx++} />
          <Row title="Featured Lessons" lessons={featured} progressByLesson={progressByLesson} onOpen={openLesson} testId="video-library-row-featured" index={rowIdx++} />
          <Row title="Recently Watched" lessons={recentlyWatchedLessons} progressByLesson={progressByLesson} onOpen={openLesson} testId="video-library-row-recent" index={rowIdx++} />
          <Row title="New Releases" lessons={newReleases} progressByLesson={progressByLesson} onOpen={openLesson} testId="video-library-row-new" index={rowIdx++} />
          <Row title="My Lessons" lessons={myPurchasedLessons} progressByLesson={progressByLesson} onOpen={openLesson} testId="video-library-row-my-lessons" index={rowIdx++} />
          <Row title="My Bookmarks" lessons={bookmarkedLessons} progressByLesson={progressByLesson} onOpen={openLesson} testId="video-library-row-bookmarks" index={rowIdx++} />
          {CATEGORY_ROWS.map((row) => (
            <Row key={row.key} title={row.label}
                 lessons={sortedLessons.filter((l) => l.category === row.key)}
                 progressByLesson={progressByLesson} onOpen={openLesson}
                 testId={`video-library-row-${row.key}`} index={rowIdx++} />
          ))}
        </div>
      )}
    </div>
  );
}
