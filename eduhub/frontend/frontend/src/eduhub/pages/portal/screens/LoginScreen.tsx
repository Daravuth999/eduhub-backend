import { motion } from "framer-motion";
import {
  GraduationCap,
  Lock,
  User,
  HelpCircle,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import type { StudentData } from "../types";
import { TopBar } from "../components/layout/TopBar";
import { AuroraBackdrop } from "../components/layout/AuroraBackdrop";
import { useLang } from "../contexts/LanguageContext";

interface Props {
  onSuccess: (student: StudentData, points: number) => void;
}

export function LoginScreen({ onSuccess }: Props) {
  const { t, lang } = useLang();
  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [hintLoading, setHintLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function getHint() {
    if (!studentId.trim()) {
      setError(t("enterIdFirst"));
      return;
    }
    setError(null);
    setHintLoading(true);
    try {
      const res = await api.passwordHint(studentId.trim());
      setHint(res.hint || res.error || t("noHint"));
    } catch {
      setHint(t("hintFetchError"));
    } finally {
      setHintLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const id = studentId.trim();
    const pw = password.trim();
    if (!id || !pw) {
      setError(t("enterBoth"));
      return;
    }
    setLoading(true);
    try {
      const data = await api.studentData(id);
      if (!data || data.error) {
        setError(data?.error || t("studentNotFound"));
        setLoading(false);
        return;
      }
      const realPassword = (data.Password ?? "").toString();
      if (pw !== realPassword) {
        setError(t("wrongPassword"));
        setLoading(false);
        return;
      }
      let points = 0;
      try {
        const p = await api.pointsLogin(data.StudentID, realPassword);
        if (p && p.success && typeof p.points === "number") points = p.points;
      } catch {
        /* points service is optional — never block login */
      }
      onSuccess({ ...data, Password: realPassword }, points);
    } catch {
      setError(t("loginGenericError"));
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen flex flex-col">
      <AuroraBackdrop />
      <TopBar
        variant="login"
        onScoreGuide={() => undefined}
        onPrint={() => undefined}
        onLogout={() => undefined}
      />

      <div className="relative flex-1 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-md"
        >
          <div className="rounded-[28px] border border-[color:var(--color-line)] bg-[color:var(--color-surface)] ink-shadow-lg p-7 sm:p-9">
            <motion.div
              initial={{ scale: 0.6, rotate: -10, opacity: 0 }}
              animate={{ scale: 1, rotate: 0, opacity: 1 }}
              transition={{ delay: 0.15, type: "spring", damping: 14 }}
              className="mx-auto mb-6 h-16 w-16 rounded-2xl flex items-center justify-center ink-shadow"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-surface)",
              }}
            >
              <GraduationCap className="h-8 w-8" />
            </motion.div>

            <div className="text-center mb-7">
              <h1 className="display text-3xl font-bold text-[color:var(--color-ink)]">
                {t("brandName")}
              </h1>
              <p className="text-sm text-[color:var(--color-ink-soft)] mt-1.5">
                {t("signIn")}
              </p>
              {lang === "en" && (
                <p className="khmer text-xs text-[color:var(--color-ink-mute)] mt-1">
                  ចូលគណនីដើម្បីមើលលទ្ធផលរបស់អ្នក
                </p>
              )}
            </div>

            <form onSubmit={handleSubmit} className="space-y-5" data-testid="login-form">
              <div>
                <label className="block text-sm font-semibold text-[color:var(--color-ink)] mb-1.5">
                  {t("studentId")}
                </label>
                <div className="relative">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[color:var(--color-ink-mute)] pointer-events-none" />
                  <input
                    type="text"
                    value={studentId}
                    onChange={(e) => setStudentId(e.target.value)}
                    placeholder="e.g., stu001"
                    autoComplete="username"
                    data-testid="student-id-input"
                    className="w-full pl-11 pr-4 py-3 rounded-xl bg-[color:var(--color-surface-2)] border border-[color:var(--color-line)] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-mute)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] mono"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-semibold text-[color:var(--color-ink)]">
                    {t("password")}
                  </label>
                  <button
                    type="button"
                    onClick={getHint}
                    disabled={hintLoading}
                    data-testid="hint-btn"
                    className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider transition"
                    style={{ color: "var(--color-accent)" }}
                  >
                    {hintLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <HelpCircle className="h-3.5 w-3.5" />
                    )}
                    {t("hint")}
                  </button>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[color:var(--color-ink-mute)] pointer-events-none" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    data-testid="password-input"
                    className="w-full pl-11 pr-4 py-3 rounded-xl bg-[color:var(--color-surface-2)] border border-[color:var(--color-line)] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-mute)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
                  />
                </div>
              </div>

              {hint && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  data-testid="hint-message"
                  className="rounded-xl px-3 py-2.5 text-sm border"
                  style={{
                    background:
                      "color-mix(in oklab, var(--color-good) 12%, var(--color-surface))",
                    borderColor:
                      "color-mix(in oklab, var(--color-good) 30%, transparent)",
                    color: "var(--color-good)",
                  }}
                >
                  <span className="font-semibold">{t("hint")}:</span> {hint}
                </motion.div>
              )}

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  data-testid="login-error"
                  className="rounded-xl px-3 py-2.5 text-sm border"
                  style={{
                    background:
                      "color-mix(in oklab, var(--color-needs) 12%, var(--color-surface))",
                    borderColor:
                      "color-mix(in oklab, var(--color-needs) 30%, transparent)",
                    color: "var(--color-needs)",
                  }}
                >
                  {error}
                </motion.div>
              )}

              <motion.button
                type="submit"
                disabled={loading}
                whileTap={{ scale: 0.97 }}
                data-testid="login-submit-btn"
                className="w-full py-3.5 rounded-xl font-semibold transition flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed ink-shadow"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-surface)",
                }}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    {t("signingIn")}
                  </>
                ) : (
                  <>
                    {t("signInBtn")} <ArrowRight className="h-5 w-5" />
                  </>
                )}
              </motion.button>
            </form>

            <p className="mt-6 text-center text-xs text-[color:var(--color-ink-mute)]">
              {t("brandTag")}
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
