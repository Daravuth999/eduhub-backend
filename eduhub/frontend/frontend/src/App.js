// App.js — unified app shell. v6 (2026-01) removes all iframe-embedded
//   third-party features and replaces them with two new native pages:
//     /systemtest → IELTS Speaking Test (native)
//     /assistant  → AI English Tutor (native, with perf upgrades)
import { lazy, Suspense, useState } from "react";
import { Routes, Route } from "react-router-dom";
import "@/App.css";

import BackgroundFx from "./eduhub/components/BackgroundFx";
import ScrollProgress from "./eduhub/components/ScrollProgress";
import Sidebar from "./eduhub/components/Sidebar";
import Header from "./eduhub/components/Header";
import Footer from "./eduhub/components/Footer";
import TelegramFab from "./eduhub/components/TelegramFab";
import MobileBottomNav from "./eduhub/components/MobileBottomNav";
import ScrollToTop from "./eduhub/components/ScrollToTop";
import ProtectedRoute from "./eduhub/components/ProtectedRoute";
import RestrictionGuard from "./eduhub/components/RestrictionGuard";
import AnnouncementPopup from "./eduhub/components/AnnouncementPopup";
import { AuthProvider } from "./eduhub/context/AuthContext";
import { LanguageProvider } from "./eduhub/pages/portal/contexts/LanguageContext";

// Lazy page-level components (Section 11 — performance)
const Dashboard      = lazy(() => import("./eduhub/pages/Dashboard"));
const LoginPage      = lazy(() => import("./eduhub/pages/LoginPage"));
const PortalPublic   = lazy(() => import("./eduhub/pages/portal/PortalPublic"));
const PortalMe       = lazy(() => import("./eduhub/pages/portal/PortalMe"));
const GamePublic     = lazy(() => import("./eduhub/pages/game/GamePublic"));
const GamePlay       = lazy(() => import("./eduhub/pages/game/GamePlay"));
const LibraryPage    = lazy(() => import("./eduhub/pages/library/LibraryPage"));
const ReaderPage     = lazy(() => import("./eduhub/pages/library/reader/ReaderPage"));
const Assistant      = lazy(() => import("./eduhub/pages/assistant/Assistant"));
const SystemTest     = lazy(() => import("./eduhub/pages/systemtest/SystemTest"));

function PageSkeleton() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="h-32 w-72 rounded-2xl skeleton border border-aurora-violet/30" />
    </div>
  );
}

function AppShell({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  return (
    <div className="App min-h-screen text-white antialiased" style={{ overflowX: "hidden" }}>
      <ScrollProgress />
      <BackgroundFx />
      <div className="relative z-10 flex min-h-screen">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} instructorName="Daravuth Yon" />
        <div
          className="flex-1 flex flex-col min-h-screen lg:ml-[256px] pb-[68px] lg:pb-0"
          style={{ minWidth: 0, overflowX: "hidden" }}
        >
          <Header onMenuClick={() => setSidebarOpen(true)} />
          <main
            className="flex-1 w-full max-w-[1080px] mx-auto px-3 sm:px-5 pt-3 sm:pt-5 pb-8 sm:pb-10"
            style={{ overflowX: "hidden" }}
            data-testid="main-content"
          >
            {children}
          </main>
          <Footer />
        </div>
      </div>
      <ScrollToTop />
      <TelegramFab />
      <MobileBottomNav onMore={() => setSidebarOpen(true)} />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <LanguageProvider>
        <Routes>
          {/* /login renders WITHOUT the standard shell */}
          <Route
            path="/login"
            element={
              <Suspense fallback={<PageSkeleton />}>
                <LoginPage />
              </Suspense>
            }
          />
          {/* Reader renders in its own full-bleed shell (no sidebar/header) */}
          <Route
            path="/library/read/:slug"
            element={
              <Suspense fallback={<PageSkeleton />}>
                <ProtectedRoute><ReaderPage /></ProtectedRoute>
              </Suspense>
            }
          />

          {/* All other routes share the AppShell */}
          <Route
            path="/*"
            element={
              <AppShell>
                <Suspense fallback={<PageSkeleton />}>
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/portal" element={<PortalPublic />} />
                    <Route
                      path="/portal/me"
                      element={<ProtectedRoute><PortalMe /></ProtectedRoute>}
                    />
                    <Route path="/game" element={<GamePublic />} />
                    <Route
                      path="/game/play"
                      element={<ProtectedRoute><GamePlay /></ProtectedRoute>}
                    />
                    <Route path="/library" element={<ProtectedRoute><LibraryPage /></ProtectedRoute>} />
                    {/* Reader is intentionally rendered outside AppShell for a focused, distraction-free reading surface */}
                    <Route path="/assistant"  element={<ProtectedRoute><Assistant /></ProtectedRoute>} />
                    <Route path="/systemtest" element={<ProtectedRoute><SystemTest /></ProtectedRoute>} />
                    <Route path="*" element={<Dashboard />} />
                  </Routes>
                </Suspense>
              </AppShell>
            }
          />
        </Routes>
        {/* App-wide restriction guard — overlays every route the moment
            AuthContext sees Restriction=TRUE for the logged-in student. */}
        <RestrictionGuard />
        {/* v7.9.10 — Smart bilingual announcement popup. Renders ONCE per
            browser session as soon as the live config has messages. */}
        <AnnouncementPopup />
      </LanguageProvider>
    </AuthProvider>
  );
}
