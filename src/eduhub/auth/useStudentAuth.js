/**
 * useStudentAuth — convenience hook for the v10.0 Render-backed student
 * auth state. Returns the new state and actions added to AuthContext
 * (alongside, never replacing, the existing GAS-backed `student`).
 *
 *   const { renderStudent, studentLoading, loginStudent, logoutStudent } =
 *     useStudentAuth();
 *
 * `renderStudent` is the source of truth for the new Render auth and is
 * intentionally named differently from the legacy `student` field on the
 * same context so both can coexist during the 48-hour cutover window.
 */
import { useContext } from "react";
import AuthCtx from "../context/AuthContext";

export function useStudentAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) {
    throw new Error("useStudentAuth must be used inside <AuthProvider>");
  }
  return {
    renderStudent: ctx.renderStudent,
    studentLoading: ctx.studentLoading,
    loginStudent: ctx.loginStudent,
    logoutStudent: ctx.logoutStudent,
  };
}
