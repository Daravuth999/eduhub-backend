// index.js — bootstrap with BrowserRouter so route-level components can
//   read `useLocation`/`useNavigate` (used by AuthContext + Sidebar).
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@/index.css";
import App from "@/App";
import { startThemeAuto } from "@/eduhub/lib/themeAuto";
// TEMPORARY — installed-PWA stale-version investigation. See __pwaDiag.js
// for removal instructions once the fix below is confirmed working on
// real devices across a few deploys.
import { initPwaDiag } from "@/eduhub/lib/__pwaDiag";
// Production fix — installed PWAs now proactively check for and safely
// apply service-worker updates instead of silently running stale code
// indefinitely. See pwaUpdateController.js for the full root-cause writeup.
import { initPwaUpdateController } from "@/eduhub/lib/pwaUpdateController";

// v10 (Heat Surgery, Feb 2026) — boot the auto day/night controller
// before first paint so initial CSS variables are correct (no FOUC).
startThemeAuto();
initPwaDiag();
initPwaUpdateController();

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
