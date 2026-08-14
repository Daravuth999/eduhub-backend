/**
 * StudentProfilePage.jsx — Premium Student Profile & Settings.
 *
 * Consolidates the identity foundation from the Authentication Completion
 * arc (status/role fields, self-service change-password, avatar upload)
 * plus real learning data (points, attendance) into one page.
 *
 * Points tile: reuses getStudentStats() from ../library/api — the EXACT
 * same GAS-backed call the Classroom Library page already uses for its
 * "POINTS" tile. Do not swap this for /api/student/points/balance (Mongo
 * points_wallets): that route is explicitly documented in
 * wallet_service.py as not-yet-authoritative (USE_MONGO_POINTS_READ
 * defaults off; GAS remains the source of truth today) and drifted from
 * the real balance for at least one account during Milestone 5's first
 * live review. Reusing the same function call, not just the same number,
 * guarantees this can never silently drift from Library again.
 * Visual language matches Home Dashboard V3 (border-radius 20/28px, glass
 * blur, gold accent #D4A843, elevation shadow scale) using the SAME
 * literal token values dashboard-world.css defines — those CSS variables
 * are deliberately scoped to `.ehw-root` only, so this page (a form-heavy
 * settings surface, not a scroll-reveal "world") reuses the values
 * directly rather than depending on that unrelated subtree.
 *
 * Every section either renders real data from an existing endpoint or is
 * omitted/shown as a clearly-labeled "not yet available" note — nothing
 * here is placeholder/fake data (XP, Level, Achievements, Badges,
 * Certificates and Speaking Lab stats have no backend source today, so
 * they are not rendered at all; see the architecture audit).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera, Loader2, LogOut, ShieldCheck, KeyRound, Bell, BellOff,
  Globe2, Wallet, Flame, CalendarCheck, Info, ExternalLink, AlertTriangle,
  CheckCircle2, X,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../portal/contexts/LanguageContext";
import { useAttendance } from "../../hooks/useAttendance";
import usePushNotifications from "../../hooks/usePushNotifications";
import ThemeToggle from "../../components/ThemeToggle";
import { getStudentStats } from "../library/api";
import { formatPoints } from "../../lib/formatPoints";
import { playUiSound } from "../../audio/uiSoundEngine";
import { useSoundSettings } from "../../audio/useSoundSettings";
import { useHaptics } from "../../lib/haptics";
import {
  getStudentProfile,
  changeStudentPassword,
  uploadStudentAvatar,
  deleteStudentAvatar,
} from "../../auth/studentAuthService";

/* Guards against rendering the literal "Invalid Date" text — if the
 * backend value is missing or unparseable, show "Not available" instead,
 * never a raw JS Date failure string. */
function formatDateSafe(value, options, emptyText = "Not available") {
  if (!value) return emptyText;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Not available";
  return options ? d.toLocaleDateString(undefined, options) : d.toLocaleString();
}

/* ─────────────────────────  design tokens (Dashboard V3)  ────────────── */
// Literal values from src/eduhub/styles/dashboard-world.css — that file's
// custom properties are scoped to `.ehw-root` only, so this page (which
// intentionally does not wrap itself in `.ehw-root`) mirrors the values
// instead of depending on that unrelated tree.
const css = {
  rRaft: 28,
  rPane: 20,
  rChip: 12,
  blurPane: 14,
  gold: "#D4A843",
  goldSoft: "rgba(212,168,67,0.35)",
  shadowE2: "0 16px 48px rgba(9,28,20,0.16)",
  danger: "rgba(239,68,68,0.9)",
  good: "rgba(34,197,94,0.9)",
};

function PremiumCard({ title, icon: Icon, children, testId }) {
  return (
    <section
      data-testid={testId}
      className="rounded-2xl p-4 sm:p-5 space-y-3"
      style={{
        borderRadius: css.rPane,
        border: `1px solid rgb(var(--bgfx-line) / 0.10)`,
        background: `rgb(var(--bgfx-card) / 0.62)`,
        backdropFilter: `blur(${css.blurPane}px)`,
        WebkitBackdropFilter: `blur(${css.blurPane}px)`,
        boxShadow: css.shadowE2,
      }}
    >
      {title && (
        <div className="flex items-center gap-2">
          {Icon && <Icon className="h-4 w-4" style={{ color: css.gold }} />}
          <h2 className="text-[13px] font-semibold uppercase tracking-wider" style={{ color: "rgb(var(--bgfx-ink))" }}>
            {title}
          </h2>
        </div>
      )}
      {children}
    </section>
  );
}

function SkeletonRow({ width = "60%" }) {
  return <div className="h-4 rounded skeleton" style={{ width }} />;
}

function Toast({ message, kind = "success", onClose }) {
  if (!message) return null;
  const Icon = kind === "error" ? AlertTriangle : CheckCircle2;
  const color = kind === "error" ? css.danger : css.good;
  return (
    <div
      role="status"
      data-testid="profile-toast"
      className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full px-4 py-2.5 text-[12px] font-semibold shadow-lg"
      style={{ background: "rgb(var(--bgfx-card))", border: `1px solid ${color}`, color: "rgb(var(--bgfx-ink))" }}
    >
      <Icon className="h-3.5 w-3.5" style={{ color }} />
      {message}
      <button type="button" onClick={onClose} aria-label="Dismiss" className="ml-1">
        <X className="h-3 w-3" style={{ color: "rgb(var(--bgfx-ink) / 0.5)" }} />
      </button>
    </div>
  );
}

/* ─────────────────────────  Profile header  ──────────────────────────── */
function ProfileHeaderCard({ profile, loading, error, onAvatarChange }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [localError, setLocalError] = useState(null);

  const initials = (profile?.display_name || "?")
    .split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  const handleFile = async (file) => {
    if (!file) return;
    setLocalError(null);
    setUploading(true);
    try {
      const res = await uploadStudentAvatar(file);
      onAvatarChange(res.avatar_url);
      playUiSound("save");
    } catch (e) {
      setLocalError(e?.message || "Upload failed");
      playUiSound("error");
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async () => {
    setLocalError(null);
    setUploading(true);
    try {
      await deleteStudentAvatar();
      onAvatarChange("");
      playUiSound("save");
    } catch (e) {
      setLocalError(e?.message || "Failed to remove photo");
      playUiSound("error");
    } finally {
      setUploading(false);
    }
  };

  if (loading) {
    return (
      <PremiumCard testId="profile-header-skeleton">
        <div className="flex items-center gap-4">
          <div className="h-20 w-20 rounded-full skeleton" />
          <div className="flex-1 space-y-2">
            <SkeletonRow width="40%" />
            <SkeletonRow width="25%" />
          </div>
        </div>
      </PremiumCard>
    );
  }

  if (error) {
    return (
      <PremiumCard testId="profile-header-error">
        <p className="text-[13px]" style={{ color: css.danger }} data-testid="profile-header-error-text">
          {error}
        </p>
      </PremiumCard>
    );
  }

  return (
    <PremiumCard testId="profile-header-card">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative">
          <div
            className="h-20 w-20 rounded-full flex items-center justify-center text-[1.4rem] font-extrabold overflow-hidden"
            style={{
              background: profile.avatar_url ? "transparent" : `linear-gradient(135deg, #FFE19A 0%, ${css.gold} 50%, #9C7A2C 100%)`,
              color: "#1a1420",
            }}
          >
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" data-testid="profile-avatar-image" />
            ) : initials}
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            data-testid="profile-avatar-upload-btn"
            aria-label="Change profile photo"
            className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full flex items-center justify-center"
            style={{ background: css.gold, color: "#1a1420", border: "2px solid rgb(var(--bgfx-card))" }}
          >
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            className="hidden"
            data-testid="profile-avatar-file-input"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-[1.05rem] font-bold truncate" data-testid="profile-display-name" style={{ color: "rgb(var(--bgfx-ink))" }}>
            {profile.display_name}
          </div>
          <div className="text-[12px]" style={{ color: "rgb(var(--bgfx-ink) / 0.55)" }}>
            @{profile.clean_id} &middot; {profile.student_id}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <span
              data-testid="profile-role-chip"
              className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
              style={{ background: `${css.goldSoft}`, color: css.gold }}
            >
              {profile.role}
            </span>
            <span
              data-testid="profile-status-chip"
              className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
              style={{
                background: profile.status === "active" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                color: profile.status === "active" ? css.good : css.danger,
              }}
            >
              {profile.status}
            </span>
            {profile.group && (
              <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: "rgb(var(--bgfx-line) / 0.08)", color: "rgb(var(--bgfx-ink) / 0.7)" }}>
                {profile.group}
              </span>
            )}
          </div>
        </div>

        {profile.avatar_url && (
          <button
            type="button"
            onClick={handleRemove}
            disabled={uploading}
            data-testid="profile-avatar-remove-btn"
            className="text-[11px] font-semibold underline"
            style={{ color: "rgb(var(--bgfx-ink) / 0.5)" }}
          >
            Remove photo
          </button>
        )}
      </div>

      {localError && (
        <p className="text-[12px]" style={{ color: css.danger }} data-testid="profile-avatar-error">
          {localError}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 pt-2 border-t" style={{ borderColor: "rgb(var(--bgfx-line) / 0.08)" }}>
        <div>
          <div className="text-[10px] uppercase tracking-wide" style={{ color: "rgb(var(--bgfx-ink) / 0.45)" }}>Joined</div>
          <div className="text-[12px] font-semibold" style={{ color: "rgb(var(--bgfx-ink))" }}>
            {formatDateSafe(profile.created_at, { year: "numeric", month: "long", day: "numeric" })}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide" style={{ color: "rgb(var(--bgfx-ink) / 0.45)" }}>Last login</div>
          <div className="text-[12px] font-semibold" style={{ color: "rgb(var(--bgfx-ink))" }}>
            {formatDateSafe(profile.last_login, undefined, "—")}
          </div>
        </div>
      </div>
    </PremiumCard>
  );
}

/* ─────────────────────────  Learning summary  ─────────────────────────── */
function LearningSummaryCard({ points, pointsLoading, pointsError, attendance }) {
  return (
    <PremiumCard title="Learning" icon={Wallet} testId="profile-learning-card">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl p-3" style={{ background: "rgb(var(--bgfx-line) / 0.05)" }} data-testid="profile-points-tile">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide" style={{ color: "rgb(var(--bgfx-ink) / 0.5)" }}>
            <Wallet className="h-3 w-3" /> Points
          </div>
          {pointsLoading ? (
            <SkeletonRow width="70%" />
          ) : pointsError || points == null ? (
            <div className="text-[12px] mt-1" style={{ color: "rgb(var(--bgfx-ink) / 0.45)" }} data-testid="profile-points-unavailable">
              Not available
            </div>
          ) : (
            <div className="text-[1.1rem] font-bold mt-0.5" style={{ color: css.gold }}>{formatPoints(points)}</div>
          )}
        </div>

        <div className="rounded-xl p-3" style={{ background: "rgb(var(--bgfx-line) / 0.05)" }} data-testid="profile-streak-tile">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide" style={{ color: "rgb(var(--bgfx-ink) / 0.5)" }}>
            <Flame className="h-3 w-3" /> Streak
          </div>
          {attendance.loading ? (
            <SkeletonRow width="50%" />
          ) : (
            <div className="text-[1.1rem] font-bold mt-0.5" style={{ color: "rgb(var(--bgfx-ink))" }}>
              {attendance.currentStreak} {attendance.currentStreak === 1 ? "day" : "days"}
            </div>
          )}
        </div>

        <div className="rounded-xl p-3" style={{ background: "rgb(var(--bgfx-line) / 0.05)" }} data-testid="profile-attendance-tile">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide" style={{ color: "rgb(var(--bgfx-ink) / 0.5)" }}>
            <CalendarCheck className="h-3 w-3" /> Attendance
          </div>
          {attendance.loading ? (
            <SkeletonRow width="60%" />
          ) : attendance.me ? (
            <div className="text-[1.1rem] font-bold mt-0.5" style={{ color: "rgb(var(--bgfx-ink))" }}>
              {Math.round((attendance.me.attendance_rate || 0) * 100)}%
            </div>
          ) : (
            <div className="text-[12px] mt-1" style={{ color: "rgb(var(--bgfx-ink) / 0.45)" }} data-testid="profile-attendance-unavailable">
              Not available
            </div>
          )}
        </div>

        <div className="rounded-xl p-3" style={{ background: "rgb(var(--bgfx-line) / 0.05)" }} data-testid="profile-tier-tile">
          <div className="text-[10px] uppercase tracking-wide" style={{ color: "rgb(var(--bgfx-ink) / 0.5)" }}>Reliability</div>
          <div className="text-[1.1rem] font-bold mt-0.5 capitalize" style={{ color: "rgb(var(--bgfx-ink))" }}>
            {attendance.loading ? <SkeletonRow width="50%" /> : (attendance.tier || "—")}
          </div>
        </div>
      </div>
    </PremiumCard>
  );
}

/* ─────────────────────────  Account  ──────────────────────────────────── */
function AccountCard({ onNotify }) {
  const { logout } = useAuth();
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);
    if (!form.current || !form.next) {
      setFormError("Enter your current and new password.");
      return;
    }
    if (form.next.length < 6) {
      setFormError("New password must be at least 6 characters.");
      return;
    }
    if (form.next !== form.confirm) {
      setFormError("New password and confirmation don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await changeStudentPassword(form.current, form.next);
      setForm({ current: "", next: "", confirm: "" });
      onNotify("Password changed. You'll need to log in again.", "success");
      playUiSound("success");
    } catch (err) {
      setFormError(err?.message || "Failed to change password");
      playUiSound("error");
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = {
    background: "rgb(var(--bgfx-line) / 0.05)",
    border: "1px solid rgb(var(--bgfx-line) / 0.12)",
    color: "rgb(var(--bgfx-ink))",
  };

  return (
    <PremiumCard title="Account" icon={KeyRound} testId="profile-account-card">
      <form onSubmit={handleSubmit} className="space-y-2.5" data-testid="profile-change-password-form">
        <input
          type="password"
          placeholder="Current password"
          value={form.current}
          onChange={(e) => setForm((f) => ({ ...f, current: e.target.value }))}
          data-testid="profile-current-password-input"
          className="w-full rounded-lg px-3 py-2 text-[13px]"
          style={inputStyle}
          autoComplete="current-password"
        />
        <input
          type="password"
          placeholder="New password"
          value={form.next}
          onChange={(e) => setForm((f) => ({ ...f, next: e.target.value }))}
          data-testid="profile-new-password-input"
          className="w-full rounded-lg px-3 py-2 text-[13px]"
          style={inputStyle}
          autoComplete="new-password"
        />
        <input
          type="password"
          placeholder="Confirm new password"
          value={form.confirm}
          onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))}
          data-testid="profile-confirm-password-input"
          className="w-full rounded-lg px-3 py-2 text-[13px]"
          style={inputStyle}
          autoComplete="new-password"
        />
        {formError && (
          <p className="text-[12px]" style={{ color: css.danger }} data-testid="profile-change-password-error">
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          data-testid="profile-change-password-submit"
          className="w-full rounded-full py-2 text-[12px] font-bold uppercase tracking-wider"
          style={{ background: css.gold, color: "#1a1420" }}
        >
          {submitting ? "Changing…" : "Change Password"}
        </button>
      </form>

      <p className="text-[11px] flex items-start gap-1.5" style={{ color: "rgb(var(--bgfx-ink) / 0.5)" }}>
        <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        Forgot your password? Sign out and use the &quot;Forgot your password?&quot; link on the login screen — your teacher will be notified to help reset it.
      </p>

      <button
        type="button"
        onClick={logout}
        data-testid="profile-logout-btn"
        className="w-full flex items-center justify-center gap-2 rounded-full py-2 text-[12px] font-semibold"
        style={{ color: css.danger, border: `1px solid ${css.danger}`, background: "rgba(239,68,68,0.06)" }}
      >
        <LogOut className="h-3.5 w-3.5" /> Sign Out
      </button>
    </PremiumCard>
  );
}

/* ─────────────────────────  Preferences  ──────────────────────────────── */
const SOUND_MODE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "soft", label: "Soft" },
  { value: "normal", label: "Normal" },
];

function PreferencesCard({ studentId, group }) {
  const { lang, toggle: toggleLang } = useLang();
  const { supported, permission, enable } = usePushNotifications(studentId, group || "default");
  const { mode: soundMode, setMode: setSoundMode } = useSoundSettings();
  const { enabled: hapticsOn, setEnabled: setHapticsOn, supported: hapticsOk } = useHaptics();

  return (
    <PremiumCard title="Preferences" icon={Globe2} testId="profile-preferences-card">
      <div className="flex items-center justify-between">
        <span className="text-[13px]" style={{ color: "rgb(var(--bgfx-ink))" }}>Language</span>
        <button
          type="button"
          onClick={toggleLang}
          data-testid="profile-language-toggle"
          className="rounded-full px-3 py-1.5 text-[12px] font-semibold"
          style={{ background: "rgb(var(--bgfx-line) / 0.08)", color: "rgb(var(--bgfx-ink))" }}
        >
          {lang === "en" ? "English" : "ខ្មែរ"}
        </button>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[13px]" style={{ color: "rgb(var(--bgfx-ink))" }}>Theme</span>
        <ThemeToggle />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[13px] flex items-center gap-1.5" style={{ color: "rgb(var(--bgfx-ink))" }}>
          {permission === "granted" ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
          Notifications
        </span>
        {!supported ? (
          <span className="text-[11px]" style={{ color: "rgb(var(--bgfx-ink) / 0.45)" }}>Not supported</span>
        ) : permission === "granted" ? (
          <span className="text-[11px] font-semibold" style={{ color: css.good }} data-testid="profile-notifications-granted">Enabled</span>
        ) : (
          <button
            type="button"
            onClick={enable}
            data-testid="profile-notifications-enable-btn"
            className="rounded-full px-3 py-1.5 text-[11px] font-semibold"
            style={{ background: css.goldSoft, color: css.gold }}
          >
            {permission === "denied" ? "Blocked — check browser settings" : "Enable"}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[13px]" style={{ color: "rgb(var(--bgfx-ink))" }}>Haptic Feedback</span>
        {!hapticsOk ? (
          <span className="text-[11px]" style={{ color: "rgb(var(--bgfx-ink) / 0.45)" }}>Not supported</span>
        ) : (
          <button
            type="button"
            onClick={() => setHapticsOn(!hapticsOn)}
            data-testid="profile-haptics-toggle"
            aria-pressed={hapticsOn}
            className="rounded-full px-3 py-1.5 text-[12px] font-semibold"
            style={
              hapticsOn
                ? { background: css.goldSoft, color: css.gold }
                : { background: "rgb(var(--bgfx-line) / 0.08)", color: "rgb(var(--bgfx-ink))" }
            }
          >
            {hapticsOn ? "On" : "Off"}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[13px]" style={{ color: "rgb(var(--bgfx-ink))" }}>Sound Effects</span>
        <div
          role="group"
          aria-label="Sound Effects"
          data-testid="profile-sound-mode-group"
          className="inline-flex rounded-full p-0.5"
          style={{ background: "rgb(var(--bgfx-line) / 0.08)" }}
        >
          {SOUND_MODE_OPTIONS.map((opt) => {
            const isActive = soundMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setSoundMode(opt.value)}
                data-testid={`profile-sound-mode-${opt.value}`}
                aria-pressed={isActive}
                className="rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors duration-150"
                style={
                  isActive
                    ? { background: css.gold, color: "#1a1420" }
                    : { color: "rgb(var(--bgfx-ink) / 0.55)" }
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-[11px]" style={{ color: "rgb(var(--bgfx-ink) / 0.45)" }}>
        Accessibility preferences aren&apos;t available yet.
      </p>
    </PremiumCard>
  );
}

/* ─────────────────────────  Security  ─────────────────────────────────── */
function SecurityCard({ profile }) {
  return (
    <PremiumCard title="Security" icon={ShieldCheck} testId="profile-security-card">
      <div className="flex items-center justify-between text-[13px]">
        <span style={{ color: "rgb(var(--bgfx-ink) / 0.6)" }}>Last login</span>
        <span style={{ color: "rgb(var(--bgfx-ink))" }}>
          {formatDateSafe(profile.last_login, undefined, "—")}
        </span>
      </div>
      <div className="flex items-center justify-between text-[13px]">
        <span style={{ color: "rgb(var(--bgfx-ink) / 0.6)" }}>Account status</span>
        <span className="capitalize" style={{ color: "rgb(var(--bgfx-ink))" }}>{profile.status}</span>
      </div>
      <p className="text-[11px] flex items-start gap-1.5" style={{ color: "rgb(var(--bgfx-ink) / 0.45)" }}>
        <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        Active-session list and sign-out-everywhere are coming in a future update.
      </p>
    </PremiumCard>
  );
}

/* ─────────────────────────  Support  ──────────────────────────────────── */
function SupportCard() {
  return (
    <PremiumCard title="Support" testId="profile-support-card">
      <a
        href="https://t.me/alita995"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="profile-support-link"
        className="flex items-center justify-between rounded-xl px-3 py-2.5"
        style={{ background: "rgb(var(--bgfx-line) / 0.05)", color: "rgb(var(--bgfx-ink))" }}
      >
        <span className="text-[13px] font-semibold">Contact us on Telegram</span>
        <ExternalLink className="h-3.5 w-3.5" style={{ color: "rgb(var(--bgfx-ink) / 0.45)" }} />
      </a>
      <p className="text-[11px]" style={{ color: "rgb(var(--bgfx-ink) / 0.45)" }}>
        Privacy Policy and Terms of Service pages aren&apos;t published yet.
      </p>
    </PremiumCard>
  );
}

/* ─────────────────────────  Root page  ─────────────────────────────────── */
export default function StudentProfilePage() {
  const { student } = useAuth();
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState(null);
  const [points, setPoints] = useState(null);
  const [pointsLoading, setPointsLoading] = useState(true);
  const [pointsError, setPointsError] = useState(null);
  const [toast, setToast] = useState(null);
  const attendance = useAttendance({ enabled: true, pollLive: false });

  const notify = useCallback((message, kind = "success") => {
    setToast({ message, kind });
  }, []);

  useEffect(() => {
    let cancelled = false;
    getStudentProfile()
      .then((data) => { if (!cancelled) setProfile(data); })
      .catch((e) => { if (!cancelled) setProfileError(e?.message || "Failed to load profile"); })
      .finally(() => { if (!cancelled) setProfileLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const studentId = student?.studentId;
    if (!studentId) {
      setPointsLoading(false);
      return undefined;
    }
    // Same call Classroom Library uses for its "POINTS" tile — see the
    // module docstring for why this must never be swapped for the Mongo
    // wallet endpoint.
    getStudentStats(studentId)
      .then((data) => {
        if (cancelled) return;
        if (data?.success) setPoints(Number(data.totalPoints) || 0);
        else setPointsError("failed");
      })
      .catch((e) => { if (!cancelled) setPointsError(e?.message || "failed"); })
      .finally(() => { if (!cancelled) setPointsLoading(false); });
    return () => { cancelled = true; };
  }, [student?.studentId]);

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-5 space-y-4" data-testid="student-profile-page">
      <h1 className="text-[15px] font-bold uppercase tracking-wider px-1" style={{ color: "rgb(var(--bgfx-ink))" }}>
        Profile &amp; Settings
      </h1>

      <ProfileHeaderCard
        profile={profile}
        loading={profileLoading}
        error={profileError}
        onAvatarChange={(url) => setProfile((p) => (p ? { ...p, avatar_url: url } : p))}
      />

      {!profileLoading && !profileError && (
        <>
          <LearningSummaryCard
            points={points}
            pointsLoading={pointsLoading}
            pointsError={pointsError}
            attendance={attendance}
          />
          <AccountCard onNotify={notify} />
          <PreferencesCard studentId={student?.studentId} group={student?.group || student?.batch} />
          <SecurityCard profile={profile} />
          <SupportCard />
        </>
      )}

      <Toast message={toast?.message} kind={toast?.kind} onClose={() => setToast(null)} />
    </div>
  );
}
