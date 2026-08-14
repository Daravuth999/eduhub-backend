/**
 * ReferralLeadModal.jsx — Public referral lead capture modal.
 *
 * Triggered from App.js when a visitor lands with `?ref=<code>`. NEVER
 * creates a student account: only stores a referral lead document for the
 * admin to action manually. If the visitor is already authenticated
 * (window.__EDUHUB_HAS_STUDENT__ flag), the modal is suppressed by the
 * caller and the ?ref= parameter is silently dropped (self-referral
 * guard).
 *
 * Backend disable / 404 / network error => modal is silently dismissed.
 */
import { useEffect, useState } from "react";
import { X, Sparkles, CheckCircle2 } from "lucide-react";
import { submitReferralLead } from "../lib/referralApi";

const STORAGE_KEY = "eduhub_referral_lead_dismissed_v1";

export default function ReferralLeadModal({ code, onClose }) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [interest, setInterest] = useState("class");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Esc to close.
    const onKey = (e) => { if (e.key === "Escape") doClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doClose = () => {
    setOpen(false);
    try { sessionStorage.setItem(STORAGE_KEY, code || "1"); } catch {}
    onClose && onClose();
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setErr("");
    if (!name.trim() || !contact.trim()) {
      setErr("Please enter your name and a contact (phone, Telegram, or email).");
      return;
    }
    setSubmitting(true);
    try {
      await submitReferralLead({
        referral_code: (code || "").toUpperCase(),
        name: name.trim(),
        contact: contact.trim(),
        interest,
      });
      setDone(true);
    } catch (e2) {
      // If the program is paused (403) or code invalid (404), just dismiss.
      if (e2 && (e2.status === 403 || e2.status === 404)) {
        doClose();
        return;
      }
      setErr(
        (e2 && e2.message) ||
        "We couldn't reach EduHub. Please try again in a moment.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="referral-lead-modal"
      className="fixed inset-0 z-[2147483600] flex items-end sm:items-center justify-center p-3"
      style={{ background: "rgba(8,5,16,0.74)", backdropFilter: "blur(6px)" }}
    >
      <div
        className="w-full max-w-[440px] rounded-3xl border p-5 sm:p-6 relative"
        style={{
          background:
            "linear-gradient(160deg, rgba(45,31,62,0.96) 0%, rgba(15,10,22,0.96) 100%)",
          borderColor: "rgba(212,168,67,0.45)",
          color: "#F4E5C1",
        }}
      >
        <button
          type="button"
          onClick={doClose}
          data-testid="referral-lead-close"
          aria-label="Close"
          className="absolute top-2.5 right-2.5 h-8 w-8 grid place-items-center rounded-full border"
          style={{ borderColor: "rgba(212,168,67,0.35)", color: "inherit" }}
        >
          <X className="h-4 w-4" />
        </button>

        {!done && (
          <>
            <div className="text-[11px] uppercase tracking-[0.24em] opacity-80 mb-1">
              <Sparkles className="h-3.5 w-3.5 inline-block mr-1 align-[-2px]" />
              You were invited
            </div>
            <h2 className="font-display text-[22px] sm:text-[26px] leading-tight mb-2">
              Join EduHub
            </h2>
            <p className="text-[13px] opacity-80 mb-4 leading-relaxed">
              Join class or start with app-only access. Tell us how to reach
              you and our team will guide you through next steps.
            </p>

            <form onSubmit={onSubmit} className="space-y-3" data-testid="referral-lead-form">
              <Field
                label="Your name"
                value={name}
                onChange={setName}
                placeholder="e.g. Dara"
                testid="referral-lead-name"
                autoFocus
              />
              <Field
                label="Phone, Telegram, or email"
                value={contact}
                onChange={setContact}
                placeholder="e.g. 012 345 678 / @username / you@mail.com"
                testid="referral-lead-contact"
              />
              <div>
                <label className="block text-[11px] uppercase tracking-wider opacity-80 mb-1.5">
                  I'm interested in
                </label>
                <div className="grid grid-cols-2 gap-2" data-testid="referral-lead-interest">
                  <ChoicePill
                    active={interest === "class"}
                    onClick={() => setInterest("class")}
                    testid="referral-lead-interest-class"
                  >
                    Join Class
                  </ChoicePill>
                  <ChoicePill
                    active={interest === "app_only"}
                    onClick={() => setInterest("app_only")}
                    testid="referral-lead-interest-app"
                  >
                    App-only Access
                  </ChoicePill>
                </div>
              </div>

              {err && (
                <p
                  data-testid="referral-lead-error"
                  className="text-[12px]"
                  style={{ color: "rgb(244, 180, 180)" }}
                >
                  {err}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                data-testid="referral-lead-submit"
                className="w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-3 text-[13px] font-bold uppercase tracking-wider disabled:opacity-60"
                style={{
                  background:
                    "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
                  color: "#1a1420",
                }}
              >
                {submitting ? "Submitting…" : "Send my request"}
              </button>

              <p className="text-[10.5px] opacity-60 text-center">
                EduHub will contact you. We never auto-create accounts from
                this form.
              </p>
            </form>
          </>
        )}

        {done && (
          <div className="py-3" data-testid="referral-lead-success">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full"
                 style={{ background: "rgba(120,200,140,0.18)" }}>
              <CheckCircle2 className="h-6 w-6" style={{ color: "rgb(160,220,170)" }} />
            </div>
            <h3 className="font-display text-[20px] text-center mb-1">Thanks!</h3>
            <p className="text-[13px] text-center opacity-80 leading-relaxed mb-4">
              We received your request. EduHub will contact you soon.
            </p>
            <button
              type="button"
              onClick={doClose}
              data-testid="referral-lead-done"
              className="w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-3 text-[13px] font-bold uppercase tracking-wider"
              style={{ background: "rgba(212,168,67,0.18)", border: "1px solid rgba(212,168,67,0.45)", color: "inherit" }}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, testid, autoFocus }) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wider opacity-80 mb-1.5">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        data-testid={testid}
        className="w-full rounded-xl px-3 py-2.5 text-[14px] outline-none border bg-transparent"
        style={{
          borderColor: "rgba(212,168,67,0.30)",
          color: "inherit",
          background: "rgba(0,0,0,0.32)",
        }}
      />
    </div>
  );
}

function ChoicePill({ active, onClick, children, testid }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className="rounded-full px-3 py-2 text-[12px] font-bold uppercase tracking-wider border transition-all"
      style={{
        background: active
          ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)"
          : "rgba(0,0,0,0.32)",
        color: active ? "#1a1420" : "inherit",
        borderColor: active ? "rgba(255,225,154,0.6)" : "rgba(212,168,67,0.30)",
      }}
    >
      {children}
    </button>
  );
}
