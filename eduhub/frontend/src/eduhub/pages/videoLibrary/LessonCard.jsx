/**
 * LessonCard.jsx — premium marketplace card for the standalone Video
 * Library. Every field is read directly off the backend lesson object
 * (video_schema.py) — nothing is fabricated for visual completeness; a
 * missing field collapses cleanly rather than showing a placeholder.
 * Exports LessonCardSkeleton for the dashboard's loading state.
 */
import { Play, Lock, Clock, GraduationCap, User, CheckCircle2 } from "lucide-react";

const GOLD = "#D4A843";

export const CATEGORY_LABELS = {
  conversation: "Conversation",
  storytelling: "Storytelling",
  business: "Business English",
  pronunciation: "Pronunciation",
  grammar: "Grammar",
  vocabulary: "Vocabulary",
  ielts: "IELTS",
  listening: "Listening",
  speaking: "Speaking",
};

export const DIFFICULTY_LABELS = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function LessonCardSkeleton() {
  return (
    <div className="flex-shrink-0 w-[168px] sm:w-[196px] rounded-xl overflow-hidden border border-white/10 bg-white/[0.03]">
      <div className="aspect-video vl-skeleton" />
      <div className="p-2.5 space-y-2">
        <div className="h-3 rounded vl-skeleton w-4/5" />
        <div className="h-2.5 rounded vl-skeleton w-3/5" />
      </div>
    </div>
  );
}

export default function LessonCard({ lesson, progressFraction, onOpen }) {
  const {
    title, subtitle, thumbnailUrl, instructor, category, difficulty, cefrLevel,
    durationSec, estimatedStudyMinutes, price, owned,
  } = lesson;

  const isPremium = Number(price) > 0;
  const hasProgress = typeof progressFraction === "number" && progressFraction > 0;

  return (
    <button
      onClick={() => onOpen?.(lesson)}
      data-testid={`video-lesson-card-${lesson.lessonId}`}
      className="vl-card group relative flex-shrink-0 w-[168px] sm:w-[196px] text-left rounded-xl overflow-hidden border border-white/10 bg-white/[0.03]"
    >
      <div className="relative aspect-video bg-black/40 overflow-hidden">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" loading="lazy"
               className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
        ) : (
          <div className="w-full h-full flex items-center justify-center"
               style={{ background: "linear-gradient(140deg, rgba(212,168,67,0.10), rgba(0,0,0,0.2) 70%)" }}>
            <Play size={22} className="text-white/25" />
          </div>
        )}

        {/* hover play affordance */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/30">
          <span className="w-9 h-9 rounded-full flex items-center justify-center"
                style={{ background: GOLD }}>
            <Play size={15} className="text-black ml-0.5" fill="currentColor" />
          </span>
        </div>

        {/* price / ownership chip */}
        <div className="absolute top-1.5 right-1.5">
          {owned && isPremium ? (
            <span className="inline-flex items-center gap-1 text-[9.5px] font-bold px-1.5 py-0.5 rounded-full"
                  style={{ background: "rgba(52,211,153,0.85)", color: "#04241a" }}>
              <CheckCircle2 size={9} /> Owned
            </span>
          ) : isPremium ? (
            <span className="inline-flex items-center gap-1 text-[9.5px] font-bold px-1.5 py-0.5 rounded-full text-black"
                  data-testid={`video-lesson-card-${lesson.lessonId}-lock`}
                  style={{ background: GOLD }}>
              <Lock size={9} /> {price} pts
            </span>
          ) : (
            <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-full bg-white/85 text-black">
              Free
            </span>
          )}
        </div>

        {durationSec > 0 && (
          <span className="absolute bottom-1.5 right-1.5 text-[9.5px] font-semibold tabular-nums px-1.5 py-0.5 rounded bg-black/70 text-white/90">
            {formatDuration(durationSec)}
          </span>
        )}

        {hasProgress && (
          <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-black/50">
            <div className="h-full" style={{ width: `${Math.min(100, progressFraction * 100)}%`, background: GOLD }} />
          </div>
        )}
      </div>

      <div className="p-2.5 space-y-1">
        <div className="text-[12.5px] font-semibold leading-snug text-ink dark:text-white line-clamp-2">{title}</div>
        {subtitle && <div className="text-[10.5px] text-zinc-500 dark:text-white/45 line-clamp-1">{subtitle}</div>}
        <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
          {category && (
            <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>
              {CATEGORY_LABELS[category] || category}
            </span>
          )}
          {difficulty && (
            <span className="inline-flex items-center gap-0.5 text-[9.5px] text-zinc-500 dark:text-white/45">
              <GraduationCap size={9} /> {DIFFICULTY_LABELS[difficulty]}
            </span>
          )}
          {cefrLevel && (
            <span className="text-[9.5px] text-zinc-500 dark:text-white/45">{cefrLevel}</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[9.5px] text-zinc-500 dark:text-white/40">
          {instructor && <span className="inline-flex items-center gap-0.5 truncate"><User size={9} /> {instructor}</span>}
          {estimatedStudyMinutes > 0 && (
            <span className="inline-flex items-center gap-0.5 flex-shrink-0"><Clock size={9} /> {estimatedStudyMinutes} min</span>
          )}
        </div>
      </div>
    </button>
  );
}
