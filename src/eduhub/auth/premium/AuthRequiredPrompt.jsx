// AuthRequiredPrompt.jsx — compact DY sign-in prompt for protected
// pages that currently show a plain "please sign in" message.
//
// Usage:
//   <AuthRequiredPrompt
//     message="Please sign in to continue."
//     loginPath="/login?redirect=/portal/me"
//   />
//
// Notes:
//   • This component does NOT auto-login, does NOT change route
//     permissions, and does NOT touch AuthContext. It only renders a
//     friendly DY-branded fallback with a clear "Go to Sign In" CTA.
//   • Caller is responsible for passing the redirect query string so
//     that the destination is restored after login.
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import DYLogo from "./DYLogo";
import "./premium-auth.css";

export default function AuthRequiredPrompt({
  title = "Please sign in to continue",
  message = "You need a DY EduHub account to access this area.",
  loginPath = "/login",
  ctaLabel = "Go to Sign In",
  testID = "auth-required-prompt",
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      data-testid={testID}
      className="mx-auto w-full rounded-[22px] border bg-white text-center"
      style={{
        maxWidth: 380,
        borderColor: "#EDEFF2",
        boxShadow:
          "0 1px 2px rgba(11,27,54,0.04), 0 12px 32px -20px rgba(11,27,54,0.18)",
        padding: "26px 22px 22px",
        color: "#0B1B36",
      }}
    >
      <div className="flex justify-center">
        <DYLogo size={64} testID={`${testID}-brand`} />
      </div>
      <h2
        className="mt-3 font-display text-[18px] font-semibold"
        style={{ letterSpacing: "-0.005em" }}
        data-testid={`${testID}-title`}
      >
        {title}
      </h2>
      <p
        className="mt-1.5 text-[13.5px]"
        style={{ color: "#6B7280" }}
        data-testid={`${testID}-message`}
      >
        {message}
      </p>
      <Link
        to={loginPath}
        data-testid={`${testID}-cta`}
        className="dy-primary-btn mt-5"
        style={{ textDecoration: "none" }}
      >
        <span className="dy-btn-shine" aria-hidden />
        {ctaLabel}
        <ArrowRight className="h-4 w-4" />
      </Link>
    </motion.div>
  );
}
