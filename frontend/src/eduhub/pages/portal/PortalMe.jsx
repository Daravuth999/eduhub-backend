// PortalMe.jsx — protected /portal/me; mounts the migrated myportal Dashboard
//   with credentials supplied by AuthContext (no local login form needed).
import { useEffect } from "react";
import { Dashboard as PortalDashboard } from "./screens/Dashboard";
import { LanguageProvider } from "./contexts/LanguageContext";
import { useAuth } from "../../context/AuthContext";
import "./portal-theme.css";

export default function PortalMe() {
  const { student, logout } = useAuth();

  // Apply portal-theme dark mode while inside /portal/me.
  useEffect(() => {
    document.documentElement.classList.add("dark");
    document.body.setAttribute("data-portal-theme", "true");
    return () => {
      document.body.removeAttribute("data-portal-theme");
    };
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
