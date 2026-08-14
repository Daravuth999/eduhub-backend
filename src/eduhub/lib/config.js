export const BACKEND_URL =
  "https://script.google.com/macros/s/AKfycby7Ca0rv5uZAalC7l0jyeQM2JQ2iX34LwW_CKB41cYiu2n4jZ9A6aK-SdGfaPkmYUmmoA/exec";
export const CACHE_KEY = "eduhub_config_v2";
export const CACHE_TTL = 5 * 60 * 1000;
export const REFRESH_INTERVAL = 5 * 60 * 1000;
export const FETCH_TIMEOUT = 8000;

export const TELEGRAM_URL = "https://t.me/alita995";

export const QUICK_LINKS = [
  { title: "Rewards Shop",   desc: "Redeem your points",         href: "https://daravuth995.github.io/Rewards-Shop/",               icon: "Gift",            variant: "rewards" },
  { title: "AI Assistant",   desc: "Instant study help",         href: "https://daravuth995.github.io/Ai-Support/",                 icon: "Bot",             variant: "ai" },
  { title: "System Test",    desc: "Run a system check",         href: "https://test.daravuthenglish.online",                       icon: "FlaskConical",    variant: "syscheck" },
  { title: "Live Sessions",  desc: "Join interactive classes",   khmer: "ចូលរៀនផ្ទាល់", href: "https://daravuth995.github.io/livesessions/",  icon: "Video",           variant: "blue" },
  { title: "Student Portal", desc: "Evaluation & progress",      khmer: "តាមដានដំណើរការ", href: "https://daravuth995.github.io/Monthly-Evaluation-Ver2/", icon: "ClipboardCheck", variant: "emerald" },
  { title: "Attendance",     desc: "Track your record",          khmer: "តាមដានវត្តមាន", href: "https://daravuth995.github.io/Attendance-/",  icon: "UserCheck",       variant: "amber" },
  { title: "Practical Class",desc: "Lab materials & exercises",  khmer: "មេរៀន & លំហាត់", href: "https://daravuth995.github.io/Edusphere-/",   icon: "Beaker",          variant: "violet" },
  { title: "Play & Earn",    desc: "Games & random picks",       khmer: "ការកម្សាន្ត",   href: "https://daravuth995.github.io/Games-Dashboard-/", icon: "Dice5",       variant: "rose" },
  { title: "Dictionary",     desc: "Look up words instantly",    href: "https://daravuth995.github.io/Dictionary-/",                icon: "BookOpen",        variant: "teal" },
];

export const SIDEBAR_NAV = {
  main: [
    { label: "Dashboard",       href: "#",                                                     icon: "LayoutDashboard", active: true },
    { label: "Live Sessions",   href: "https://daravuth995.github.io/livesessions/",           icon: "Video" },
    { label: "Evaluation",      href: "https://daravuth995.github.io/Monthly-Evaluation-Ver2/", icon: "ClipboardCheck" },
    { label: "Attendance",      href: "https://daravuth995.github.io/Attendance-/",             icon: "UserCheck", badge: "New" },
    { label: "Practical Class", href: "https://daravuth995.github.io/Edusphere-/",              icon: "Beaker" },
  ],
  extras: [
    { label: "Rewards Shop", href: "https://daravuth995.github.io/Rewards-Shop/", icon: "Gift" },
    { label: "AI Assistant", href: "https://daravuth995.github.io/Ai-Support/",   icon: "Bot" },
    { label: "Play & Earn",  href: "https://daravuth995.github.io/Games-Dashboard-/", icon: "Dice5" },
    { label: "Dictionary",   href: "https://daravuth995.github.io/Dictionary-/",  icon: "BookOpen" },
    { label: "System Test",  href: "https://test.daravuthenglish.online",         icon: "FlaskConical" },
  ],
};

export const defaultConfig = {
  title: "Welcome to Our Classroom",
  khmerWelcome: "ស្វាគមន៍មកកាន់ថ្នាក់រៀន",
  subtitle: "Interactive Learning Portal",
  instructorName: "Daravuth Yon",
  announcementTitle: "IMPORTANT ANNOUNCEMENT",
  announcementMessages: [
    "Patience is the only key to unlocking your speaking success. It's still early — but it's the perfect time to commit.",
    "ភាពអត់ធ្មត់ ជាមធ្យោបាយតែមួយគត់ដែលនឹងដឹកនាំអ្នកទៅរកភាពជោគជ័យក្នុងការនិយាយរបស់អ្នក។",
  ],
  enableTypewriter: true,
  typewriterSpeed: 28,
  initialDelay: 0.4,
  betweenMessagesDelay: 0.3,
  stats: {
    evaluation:  { value: null, trend: "neutral", label: "Evaluation Score" },
    points:      { value: null, trend: "up",      label: "Total Points" },
    attendance:  { value: null, trend: "neutral", label: "Attendance Rate" },
    leaderboard: { value: null, trend: "up",      label: "Leaderboard Rank" },
  },
};

export function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* ignore */ }
}
// Dashboard Bootstrap / true stale-while-revalidate: the last successfully
// fetched config is returned regardless of age — CACHE_TTL now only gates
// how often `update()` re-fetches (see useEduHubConfig's REFRESH_INTERVAL),
// not whether the cache is visible. A long offline stretch should keep
// showing the last real announcement/content, never silently degrade to
// the hardcoded defaultConfig just because CACHE_TTL elapsed.
export function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { data } = JSON.parse(raw);
    return data || null;
  } catch { /* ignore */ }
  return null;
}

export function fetchJSONP(url) {
  return new Promise((resolve, reject) => {
    const cb = "__ehcb_" + Date.now();
    const sc = document.createElement("script");
    const tm = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, FETCH_TIMEOUT);
    window[cb] = (d) => { cleanup(); resolve(d); };
    function cleanup() {
      clearTimeout(tm);
      try { delete window[cb]; } catch { /* ignore */ }
      sc.parentNode?.removeChild(sc);
    }
    sc.onerror = () => { cleanup(); reject(new Error("script error")); };
    sc.src = `${url}${url.includes("?") ? "&" : "?"}callback=${cb}`;
    document.head.appendChild(sc);
  });
}

export function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal, redirect: "follow", credentials: "omit", cache: "no-store", mode: "cors" })
    .finally(() => clearTimeout(id));
}

export function normalizeConfig(raw) {
  const r = raw || {};
  const stats = {
    evaluation:  { ...defaultConfig.stats.evaluation,  ...(r.stats?.evaluation  || {}) },
    points:      { ...defaultConfig.stats.points,      ...(r.stats?.points      || {}) },
    attendance:  { ...defaultConfig.stats.attendance,  ...(r.stats?.attendance  || {}) },
    leaderboard: { ...defaultConfig.stats.leaderboard, ...(r.stats?.leaderboard || {}) },
  };
  if (!r.stats) {
    if (r.evaluationScore !== undefined) stats.evaluation.value = String(r.evaluationScore);
    if (r.evaluationTrend !== undefined) stats.evaluation.trend = r.evaluationTrend;
    if (r.totalPoints !== undefined)     stats.points.value = String(r.totalPoints);
    if (r.pointsTrend !== undefined)     stats.points.trend = r.pointsTrend;
    if (r.attendanceRate !== undefined)
      stats.attendance.value = r.attendanceRate + (String(r.attendanceRate).includes("%") ? "" : "%");
    if (r.attendanceTrend !== undefined) stats.attendance.trend = r.attendanceTrend;
    if (r.leaderboardRank !== undefined) stats.leaderboard.value = "#" + r.leaderboardRank;
    if (r.leaderboardTrend !== undefined) stats.leaderboard.trend = r.leaderboardTrend;
  }
  return {
    title: r.title || defaultConfig.title,
    khmerWelcome: r.khmerWelcome || defaultConfig.khmerWelcome,
    subtitle: r.subtitle || defaultConfig.subtitle,
    instructorName: r.instructorName || defaultConfig.instructorName,
    announcementTitle: r.announcementTitle || defaultConfig.announcementTitle,
    announcementMessages: r.announcementMessages?.length ? r.announcementMessages : defaultConfig.announcementMessages,
    enableTypewriter: r.enableTypewriter ?? defaultConfig.enableTypewriter,
    typewriterSpeed: r.typewriterSpeed ?? defaultConfig.typewriterSpeed,
    initialDelay: r.initialDelay ?? defaultConfig.initialDelay,
    betweenMessagesDelay: r.betweenMessagesDelay ?? defaultConfig.betweenMessagesDelay,
    stats,
  };
}
