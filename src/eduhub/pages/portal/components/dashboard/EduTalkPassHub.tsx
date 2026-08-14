/**
 * EduTalkPassHub.tsx — premium compact EduTalk pass wallet for My Portal.
 *
 * Source of truth: GET /api/student/edutalk-passes (MongoDB-backed).
 * Status (active / used / expired) is computed by the backend from
 * `student_feature_entitlements`. NO localStorage truth, NO mock data.
 *
 * Vouchers and pass codes are NEVER exposed: passes are private
 * student-owned entitlements consumed transparently inside the EduTalk
 * session/voice routes when the student opens a Reader EduTalk session.
 *
 * EduHub Lumio (2026): repaletted to the unified light "Aurora" reward
 * palette (cream surfaces + violet accent). Data flow, the hide-when-empty
 * contract, and all behaviour are preserved verbatim — only presentation
 * changed.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Sparkles, Ticket, Mic, MessageCircle } from "lucide-react";
import { listStudentEduTalkPasses } from "../../../../lib/edutalkPassApi";

interface PassRow {
  id: string;
  feature: "edutalk_session" | "edutalk_voice" | string;
  title: string;
  quantity_total: number;
  quantity_remaining: number;
  eligible_book_slugs: string[];
  applies_to_all_books: boolean;
  source: string;
  expires_at: string | null;
  status: "active" | "used" | "expired" | string;
  created_at: string;
}

interface Props {
  refreshKey?: number;
}

function formatExpiry(iso: string | null): string {
  if (!iso) return "No expiry";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    const opts: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      year: "numeric",
    };
    return `Expires ${d.toLocaleDateString(undefined, opts)}`;
  } catch {
    return "—";
  }
}

function PassCard({ pass }: { pass: PassRow }) {
  const isVoice = pass.feature === "edutalk_voice";
  const Icon = isVoice ? Mic : MessageCircle;
  const isActive = pass.status === "active" && pass.quantity_remaining > 0;

  return (
    <div
      data-testid={`edutalk-pass-card-${pass.id}`}
      data-accent="violet"
      className="lumio-surface relative overflow-hidden p-4"
      style={{
        background: isActive
          ? "color-mix(in oklab, var(--color-accent) 8%, var(--color-surface))"
          : "var(--color-surface-2)",
        borderColor: isActive ? "color-mix(in oklab, var(--color-accent) 32%, var(--color-line))" : "var(--color-line)",
        opacity: isActive ? 1 : 0.72,
      }}
    >
      {isActive && (
        <div
          className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
          style={{
            background: "var(--gradient-violet)",
            color: "#fff",
          }}
        >
          <Sparkles className="h-2.5 w-2.5" />
          Active
        </div>
      )}
      <div className="flex items-start gap-3">
        <div
          className="aurora-icon-badge h-11 w-11 flex-shrink-0"
          data-accent="violet"
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[color:var(--color-ink)] text-[14px] truncate">
            {pass.title || (isVoice ? "EduTalk Voice Reply Pass" : "EduTalk Session Pass")}
          </div>
          <div className="text-[11px] text-[color:var(--color-ink-mute)] mt-0.5">
            {pass.quantity_remaining} of {pass.quantity_total} use
            {pass.quantity_total === 1 ? "" : "s"} left
            {" · "}
            {pass.applies_to_all_books
              ? "all books"
              : `${pass.eligible_book_slugs.length} eligible book${pass.eligible_book_slugs.length === 1 ? "" : "s"}`}
          </div>
          <div className="text-[10.5px] text-[color:var(--color-ink-mute)] mt-1.5 uppercase tracking-wider">
            {pass.status === "expired"
              ? "Expired"
              : pass.status === "used"
                ? "Used"
                : formatExpiry(pass.expires_at)}
          </div>
          {isActive && (
            <div className="mt-2 text-[11px] text-[color:var(--color-accent)]">
              Open any eligible book → EduTalk to use this pass.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function EduTalkPassHub({ refreshKey }: Props) {
  const [passes, setPasses] = useState<PassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listStudentEduTalkPasses();
      setPasses((data && data.passes) || []);
    } catch (e: any) {
      // If the endpoint is not registered yet (404), silently hide.
      if (e?.status === 404) {
        setPasses([]);
      } else {
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Hide section entirely when there are no passes AND no error. EduTalk
  // passes are a bonus reward — students who never won one shouldn't see
  // an empty container in their portal.
  if (!loading && !error && passes.length === 0) {
    return null;
  }

  return (
    <section
      data-testid="edutalk-pass-hub"
      data-accent="violet"
      className="lumio-surface lumio-surface--strip p-4 mt-3"
    >
      <header className="flex items-center gap-2 mb-3">
        <span className="aurora-icon-badge h-6 w-6" data-accent="violet">
          <Ticket className="h-3.5 w-3.5" />
        </span>
        <h3 className="text-[12px] font-bold uppercase tracking-wider text-[color:var(--color-ink)]">
          EduTalk Passes
        </h3>
        {passes.length > 0 && (
          <span className="text-[10px] text-[color:var(--color-ink-mute)]">
            ({passes.filter((p) => p.status === "active" && p.quantity_remaining > 0).length} active)
          </span>
        )}
      </header>

      {error && (
        <div
          className="flex items-start gap-2 rounded-xl p-3 text-[12px]"
          style={{
            background: "color-mix(in oklab, var(--color-needs) 8%, transparent)",
            border: "1px solid color-mix(in oklab, var(--color-needs) 30%, transparent)",
            color: "var(--color-needs)",
          }}
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div>Could not load passes. {error.message}</div>
        </div>
      )}

      {!error && loading && (
        <div className="text-[12px] text-[color:var(--color-ink-mute)] italic">
          Loading passes…
        </div>
      )}

      {!error && !loading && passes.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {passes.map((p) => (
            <PassCard key={p.id} pass={p} />
          ))}
        </div>
      )}
    </section>
  );
}

export default EduTalkPassHub;
