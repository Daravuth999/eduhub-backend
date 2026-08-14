/**
 * MediaPanel.jsx — Media Management stage: the premium native upload
 * experience. Drag & drop or click, upload queue with live percentage +
 * transfer speed, retry on failure, replace/delete/preview, storage chip
 * (Cloudflare R2 vs GridFS fallback — decided server-side, surfaced here),
 * and the thumbnail manager (upload, center-crop to 16:9, automatic
 * compression, preview, replace). No manual URL pasting anywhere.
 */
import { useRef, useState } from "react";
import {
  UploadCloud, Film, Trash2, Loader2, RefreshCw, CheckCircle2,
  AlertTriangle, Image as ImageIcon, Cloud, Database, Music,
} from "lucide-react";
import { uploadLessonMedia, uploadThumbnail, deleteMedia, resolveMediaSrc } from "../videoLibraryApi";

const GOLD = "#D4A843";
const ACCEPT_MEDIA = "video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a";

function fmtBytes(n) {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** Center-crops an image to 16:9 and compresses it to JPEG ≤ 0.5 MB. */
async function cropAndCompressThumbnail(file) {
  const bitmap = await createImageBitmap(file);
  const targetRatio = 16 / 9;
  let sw = bitmap.width, sh = bitmap.height, sx = 0, sy = 0;
  if (sw / sh > targetRatio) { sw = Math.round(sh * targetRatio); sx = Math.round((bitmap.width - sw) / 2); }
  else { sh = Math.round(sw / targetRatio); sy = Math.round((bitmap.height - sh) / 2); }
  const outW = Math.min(1280, sw);
  const outH = Math.round(outW / targetRatio);
  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);
  for (const q of [0.85, 0.7, 0.55]) {
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= 512 * 1024) return new File([blob], "thumbnail.jpg", { type: "image/jpeg" });
    if (q === 0.55 && blob) return new File([blob], "thumbnail.jpg", { type: "image/jpeg" });
  }
  return file;
}

export default function MediaPanel({ lesson, onChanged, onPipelineStarted }) {
  const fileRef = useRef(null);
  const thumbRef = useRef(null);
  const lastFileRef = useRef(null);
  const rateRef = useRef({ t: 0, loaded: 0 });
  const [dragOver, setDragOver] = useState(false);
  const [upload, setUpload] = useState(null); // {name,size,pct,rate,state:'uploading'|'done'|'failed',error}
  const [thumbBusy, setThumbBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const hasMedia = Boolean(lesson.mediaRef);
  const isVideo = (lesson.contentType || "").startsWith("video/");
  const onR2 = hasMedia && !String(lesson.mediaRef).startsWith("gridfs://");
  const published = lesson.status === "published";

  const startUpload = async (file) => {
    if (!file) return;
    if (!ACCEPT_MEDIA.split(",").includes(file.type) && !file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
      setErr(`Unsupported file type: ${file.type || "unknown"}`);
      return;
    }
    setErr(null);
    lastFileRef.current = file;
    rateRef.current = { t: Date.now(), loaded: 0 };
    setUpload({ name: file.name, size: file.size, pct: 0, rate: 0, state: "uploading", error: null });
    try {
      await uploadLessonMedia(lesson.lessonId, file, {
        onProgress: (f) => {
          const now = Date.now();
          const loaded = f * file.size;
          const dt = (now - rateRef.current.t) / 1000;
          let rate = 0;
          if (dt > 0.4) {
            rate = (loaded - rateRef.current.loaded) / dt;
            rateRef.current = { t: now, loaded };
          }
          setUpload((u) => u && { ...u, pct: f, rate: rate || u.rate });
        },
      });
      setUpload((u) => u && { ...u, pct: 1, state: "done" });
      onPipelineStarted?.();
      onChanged();
    } catch (ex) {
      setUpload((u) => u && { ...u, state: "failed", error: ex.message || "Upload failed." });
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    startUpload(e.dataTransfer?.files?.[0]);
  };

  const handleThumb = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setErr(null);
    setThumbBusy(true);
    try {
      const processed = await cropAndCompressThumbnail(file);
      await uploadThumbnail(lesson.lessonId, processed);
      onChanged();
    } catch (ex) {
      setErr(ex.message || "Thumbnail upload failed.");
    } finally {
      setThumbBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Remove this lesson's media? The transcript and AI analysis will be cleared too.")) return;
    setErr(null);
    setBusy(true);
    try {
      await deleteMedia(lesson.lessonId);
      setUpload(null);
      onChanged();
    } catch (ex) {
      setErr(ex.message || "Delete failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="production-media-panel">
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
        data-testid="media-drop-zone"
        className="rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors"
        style={{
          borderColor: dragOver ? GOLD : "rgba(255,255,255,0.14)",
          background: dragOver ? "rgba(212,168,67,0.06)" : "rgba(255,255,255,0.02)",
        }}
      >
        <UploadCloud size={28} className="mx-auto mb-2" style={{ color: dragOver ? GOLD : "rgba(255,255,255,0.35)" }} />
        <div className="text-[13px] font-semibold text-parchment">
          {hasMedia ? "Drop a new file to replace this lesson's media" : "Drag & drop your video or audio here"}
        </div>
        <div className="text-[11px] text-faded mt-1">
          or click to browse · MP4, WebM, MOV, MP3, WAV, M4A · uploaded natively to Cloudflare R2
        </div>
        <input ref={fileRef} type="file" accept={ACCEPT_MEDIA} className="hidden"
               data-testid="media-file-input"
               onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; startUpload(f); }} />
      </div>

      {/* Upload queue entry */}
      {upload && (
        <div className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2" data-testid="media-upload-item">
          <div className="flex items-center gap-2">
            {upload.state === "uploading" && <Loader2 size={14} className="animate-spin" style={{ color: GOLD }} />}
            {upload.state === "done" && <CheckCircle2 size={14} className="text-emerald-300" />}
            {upload.state === "failed" && <AlertTriangle size={14} className="text-red-400" />}
            <span className="text-[12px] text-parchment truncate flex-1">{upload.name}</span>
            <span className="text-[10.5px] text-faded tabular-nums">{fmtBytes(upload.size)}</span>
          </div>
          {upload.state === "uploading" && (
            <>
              <div className="h-1.5 rounded-full bg-black/40 overflow-hidden">
                <div className="h-full rounded-full transition-[width] duration-200"
                     style={{ width: `${upload.pct * 100}%`, background: GOLD }} />
              </div>
              <div className="flex justify-between text-[10.5px] text-faded tabular-nums">
                <span data-testid="media-upload-pct">{Math.round(upload.pct * 100)}%</span>
                {upload.rate > 0 && <span data-testid="media-upload-speed">{fmtBytes(upload.rate)}/s</span>}
              </div>
            </>
          )}
          {upload.state === "done" && (
            <div className="text-[11px] text-emerald-300/80">Upload complete — AI processing started automatically.</div>
          )}
          {upload.state === "failed" && (
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-red-400">{upload.error}</span>
              <button onClick={() => startUpload(lastFileRef.current)}
                      data-testid="media-retry-button"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-amber-400/40 text-amber-300">
                <RefreshCw size={11} /> Retry upload
              </button>
            </div>
          )}
        </div>
      )}

      {/* Current media + storage info */}
      {hasMedia && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-3" data-testid="media-current">
          <div className="flex items-center gap-2 flex-wrap">
            {isVideo ? <Film size={13} className="text-amber-300" /> : <Music size={13} className="text-amber-300" />}
            <span className="text-[12px] font-semibold text-parchment">Current media</span>
            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full"
                  data-testid="media-storage-chip"
                  style={onR2
                    ? { background: "rgba(96,165,250,0.12)", color: "#93c5fd", border: "1px solid rgba(96,165,250,0.3)" }
                    : { background: "rgba(255,255,255,0.06)", color: "#9ca3af", border: "1px solid rgba(255,255,255,0.12)" }}>
              {onR2 ? <><Cloud size={9} /> Cloudflare R2</> : <><Database size={9} /> GridFS (R2 not configured)</>}
            </span>
            {lesson.contentType && <span className="text-[10px] text-faded">{lesson.contentType}</span>}
            {lesson.durationSec > 0 && <span className="text-[10px] text-faded tabular-nums">{Math.round(lesson.durationSec)}s</span>}
            <button onClick={handleDelete} disabled={busy || published}
                    title={published ? "Unpublish before removing media" : "Remove media"}
                    data-testid="media-delete-button"
                    className="ml-auto inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-red-500/20 bg-red-500/10 text-red-300 disabled:opacity-40">
              <Trash2 size={11} /> Delete media
            </button>
          </div>
          <div className="rounded-lg overflow-hidden bg-black" data-testid="media-preview">
            {isVideo
              ? <video src={resolveMediaSrc(lesson.mediaRef)} controls className="w-full max-h-[280px]" />
              : <audio src={resolveMediaSrc(lesson.mediaRef)} controls className="w-full px-2 py-3" />}
          </div>
        </div>
      )}

      {/* Thumbnail manager */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2" data-testid="media-thumbnail-manager">
        <div className="flex items-center gap-2">
          <ImageIcon size={13} className="text-amber-300" />
          <span className="text-[12px] font-semibold text-parchment">Thumbnail</span>
          <span className="text-[10px] text-faded">auto-cropped to 16:9 · compressed automatically</span>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => thumbRef.current?.click()} disabled={thumbBusy}
                  data-testid="media-thumb-button"
                  className="relative w-44 aspect-video rounded-lg bg-black/30 border border-white/10 overflow-hidden group flex items-center justify-center">
            {lesson.thumbnailUrl
              ? <img src={lesson.thumbnailUrl} alt="" className="w-full h-full object-cover" />
              : <span className="text-[10.5px] text-faded">Click to upload</span>}
            <span className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              {thumbBusy ? <Loader2 size={14} className="animate-spin text-white" /> : <UploadCloud size={14} className="text-white" />}
            </span>
          </button>
          <input ref={thumbRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                 data-testid="media-thumb-input" onChange={handleThumb} />
          <div className="text-[11px] text-faded leading-relaxed">
            {lesson.thumbnailUrl ? "Click the preview to replace." : "JPEG, PNG or WebP."}<br />
            Stored on Cloudflare R2 when configured.
          </div>
        </div>
      </div>

      {err && <div className="text-xs text-red-400" data-testid="media-error">{err}</div>}
    </div>
  );
}
