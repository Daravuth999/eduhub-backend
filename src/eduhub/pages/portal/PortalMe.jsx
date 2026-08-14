// PortalMe.jsx — protected /portal/me; mounts the migrated myportal Dashboard
//   with credentials supplied by AuthContext (no local login form needed).
//
// v16 (EduHub Lumio runtime correction, 2026)
// ────────────────────────────────────────────────────────────────────
// The portal NO LONGER owns or pins the theme. The global controller
// (src/eduhub/lib/themeAuto.js) is the single source of truth for
// `.dark`, `data-theme`, the browser theme-color, and the auto/light/dark
// modes (it re-applies on focus / visibilitychange / interval). PortalMe
// must not read, write, snapshot, or restore any theme preference.
//
// We only flag the body with data-portal-theme="true" so portal-theme.css
// can scope its Aurora surface tokens. That flag is purely a CSS scope —
// it does not change the global theme. The portal therefore renders in
// whatever theme the global controller currently resolves (and the slim
// PortalAppBar's toggle drives changes through that same controller).
import { useEffect } from "react";
import { Dashboard as PortalDashboard } from "./screens/Dashboard";
import { LanguageProvider } from "./contexts/LanguageContext";
import { useAuth } from "../../context/AuthContext";
import "./portal-theme.css";

export default function PortalMe() {
  const { student, logout } = useAuth();

  // CSS scope flag only — no theme override of any kind.
  useEffect(() => {
    document.body.setAttribute("data-portal-theme", "true");
    return () => document.body.removeAttribute("data-portal-theme");
  }, []);

  if (!student?.portalData) return null;

  return (
    <LanguageProvider>
      <PortalDashboard
        student={student.portalData}
        password={student.password}
        initialPoints={student.portalPoints ?? 0}
        onLogout={logout}
      />
    </LanguageProvider>
  );
}
