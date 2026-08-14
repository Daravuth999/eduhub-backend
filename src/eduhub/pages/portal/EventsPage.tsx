import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Trophy, Users, Coins, CalendarClock } from "lucide-react";
import { Surface } from "./components/primitives/Surface";
import { Pill } from "./components/primitives/Pill";
import {
  eventEngineApi,
  EventEngineApiError,
  type AvailableEvent,
  type EventRegisterResult,
} from "./lib/eventEngineApi";

/**
 * EventsPage — "browse available events, register, view tickets"
 * (architecture.md continuation, Student PWA). Lists every event
 * currently open for registration across every event_type (not just
 * Speaking Lab) via GET /api/v1/events/available, and lets a student
 * register via POST /api/v1/events/{id}/register — the SAME atomic
 * join transaction speakingLabApi.ts's joinActive() already uses.
 *
 * "Wrap, don't rewrite": this does not replace the existing one-tap
 * SpeakingLabLiveCard on the Dashboard — that stays exactly as-is for
 * the "is there a live session for me right now" fast path. This page
 * is the discovery surface for browsing ALL open events by template,
 * a capability the session-only card doesn't have.
 */

type RegState =
  | { kind: "idle" }
  | { kind: "registering" }
  | { kind: "registered"; result: EventRegisterResult }
  | { kind: "error"; message: string };

const REGISTER_ERROR_MESSAGES: Record<string, string> = {
  insufficient_points: "You don't have enough points to join this event.",
  wallet_not_ready: "Your wallet isn't ready yet — ask your teacher for help.",
  schedule_assignment_required: "Ask your teacher to assign you to Schedule A or B first.",
  wrong_schedule: "This event is for a different schedule group than yours.",
  event_not_open: "This event is not open for registration right now.",
  draw_locked: "The draw for this event has already started.",
  default: "We couldn't complete that just now. Please try again.",
};

function registerErrorMessage(code: string): string {
  return REGISTER_ERROR_MESSAGES[code] || REGISTER_ERROR_MESSAGES.default;
}

const STATE_PILL_TONE: Record<string, "accent" | "good" | "needs" | "warm" | "ink"> = {
  registration_open: "good",
  live: "accent",
};
const STATE_LABEL: Record<string, string> = {
  registration_open: "Open for registration",
  live: "Live now",
};

export default function EventsPage() {
  const [events, setEvents] = useState<AvailableEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [regByEvent, setRegByEvent] = useState<Record<string, RegState>>({});
  const [copiedFor, setCopiedFor] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await eventEngineApi.listAvailableEvents();
      setEvents(list);
    } catch (e) {
      const msg = e instanceof EventEngineApiError ? e.message : "Couldn't load events right now.";
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleRegister = async (eventId: string) => {
    setRegByEvent((prev) => ({ ...prev, [eventId]: { kind: "registering" } }));
    try {
      const result = await eventEngineApi.registerForEvent(eventId);
      setRegByEvent((prev) => ({ ...prev, [eventId]: { kind: "registered", result } }));
    } catch (e) {
      const code = e instanceof EventEngineApiError ? e.code : "default";
      setRegByEvent((prev) => ({
        ...prev,
        [eventId]: { kind: "error", message: registerErrorMessage(code) },
      }));
    }
  };

  const handleCopy = async (code: string, eventId: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedFor(eventId);
      setTimeout(() => setCopiedFor((prev) => (prev === eventId ? null : prev)), 1500);
    } catch {
      /* clipboard unavailable — copy button simply won't confirm, non-fatal */
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-4" data-testid="events-page">
      <div className="flex items-center gap-2">
        <div aria-hidden data-accent="teal" className="aurora-icon-badge h-8 w-8">
          <CalendarClock className="h-4 w-4" />
        </div>
        <h1 className="display text-xl font-bold text-[color:var(--color-ink)]">Events</h1>
      </div>

      {loading && (
        <div className="text-sm text-[color:var(--color-ink-soft)]" data-testid="events-page-loading">
          Loading events…
        </div>
      )}

      {!loading && loadError && (
        <Surface accent="none" className="p-4" role="alert" data-testid="events-page-error">
          <p className="text-sm text-[color:var(--color-ink)]">{loadError}</p>
        </Surface>
      )}

      {!loading && !loadError && events.length === 0 && (
        <div className="text-sm text-[color:var(--color-ink-soft)]" data-testid="events-page-empty">
          No events are open right now — check back soon.
        </div>
      )}

      <div className="space-y-3">
        {events.map((ev) => {
          const reg = regByEvent[ev._id] || { kind: "idle" as const };
          return (
            <Surface key={ev._id} accent="teal" className="p-4" data-testid={`events-page-card-${ev._id}`}>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-[color:var(--color-ink)] truncate">
                      {ev.template_name}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-[color:var(--color-ink-soft)]">
                      <Pill tone={STATE_PILL_TONE[ev.state] || "ink"}>
                        {STATE_LABEL[ev.state] || ev.state}
                      </Pill>
                      {ev.schedule && <span>Schedule {ev.schedule}</span>}
                      <span className="inline-flex items-center gap-1">
                        <Coins className="h-3.5 w-3.5" /> Entry: {ev.entry_fee} pts
                      </span>
                    </div>
                  </div>
                  {reg.kind !== "registered" && (
                    <button
                      type="button"
                      onClick={() => handleRegister(ev._id)}
                      disabled={reg.kind === "registering"}
                      data-accent="violet"
                      data-testid={`events-page-register-${ev._id}`}
                      className="aurora-glow-btn"
                    >
                      {reg.kind === "registering" ? "Registering…" : "Register"}
                    </button>
                  )}
                </div>

                {reg.kind === "registered" && (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <div aria-hidden data-accent="green" className="aurora-icon-badge h-7 w-7">
                        <Check className="h-3.5 w-3.5" />
                      </div>
                      <span className="text-sm font-bold text-[color:var(--color-ink)]">You're In!</span>
                    </div>
                    <div
                      className="rounded-xl px-4 py-3 flex items-center justify-between gap-3"
                      style={{ background: "var(--color-surface)", border: "1px solid var(--color-line)" }}
                    >
                      <div className="min-w-0">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-ink-mute)]">
                          Your Ticket
                        </div>
                        <div
                          className="mono text-lg font-bold text-[color:var(--color-ink)] truncate"
                          data-testid={`events-page-ticket-${ev._id}`}
                        >
                          {reg.result.lucky_code}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleCopy(reg.result.lucky_code, ev._id)}
                        className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold min-h-[40px]"
                        style={{ background: "var(--color-surface-2)", color: "var(--color-ink)" }}
                      >
                        {copiedFor === ev._id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {copiedFor === ev._id ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-[color:var(--color-ink-soft)]">
                      {typeof reg.result.pool_total === "number" && (
                        <span className="inline-flex items-center gap-1">
                          <Trophy className="h-3.5 w-3.5" /> Pool: {reg.result.pool_total} pts
                        </span>
                      )}
                      {typeof reg.result.player_count === "number" && (
                        <span className="inline-flex items-center gap-1">
                          <Users className="h-3.5 w-3.5" /> {reg.result.player_count} players
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {reg.kind === "error" && (
                  <div role="alert" className="flex flex-col gap-2">
                    <p className="text-sm text-[color:var(--color-ink)]">{reg.message}</p>
                    <button
                      type="button"
                      onClick={() => handleRegister(ev._id)}
                      data-accent="violet"
                      data-testid={`events-page-retry-${ev._id}`}
                      className="aurora-glow-btn self-start"
                    >
                      Try again
                    </button>
                  </div>
                )}
              </div>
            </Surface>
          );
        })}
      </div>
    </div>
  );
}
