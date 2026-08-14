// StickyComposer.jsx — the composer dock (avatar, textarea, mic, send/stop).
//
// v4 — Layout Architecture rebuild. This used to be a responsive wrapper
// that put the dock at `position: fixed` on phones (offset upward by
// safe-area + --eduhub-bottom-nav-h + a live keyboard inset from
// useKeyboardSafeArea) or `position: sticky` on desktop. That whole
// wrapper is gone: the composer is now rendered by its parent
// (FreeChatPanel, inside Assistant.jsx) as a normal flex child at the
// bottom of the page's own flex column, whose height already tracks the
// dynamic viewport (`.ai-shell-v2` in assistant-premium.css). Because
// the shell shrinks with the on-screen keyboard, the composer — as its
// last flex child — is naturally pinned above it, with no manual offset
// math and no risk of jumping or overlapping. This component now owns
// only the dock's own visual contents.
//
// All callbacks, refs and state are still owned by FreeChatPanel — this
// component owns NO state, NO API calls, NO AuthContext access. That
// preserves the wallet-race fix, the send() busy/abort logic, and the
// existing data-testid contract:
//   ai-coach-input-dock, ai-coach-input, ai-coach-mic-btn,
//   ai-coach-mic-stop-btn, ai-coach-stop-btn, ai-coach-send-btn.

import React from "react";
import { Mic, MicOff, Send, Square, MessageSquare } from "lucide-react";

function initials(name = "") {
  const p = String(name).trim().split(/\s+/);
  if (!p.length || !p[0]) return "ME";
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

export default function StickyComposer({
  taRef,
  value,
  onInput,
  onKeyDown,
  placeholder,
  disabled,
  studentName,
  voiceAvailable,
  listening,
  onMicStart,
  onMicStop,
  busy,
  onSend,
  onStop,
  sendDisabled,
  needsWalletPw,
  featureDisabled,
}) {
  return (
    <div
      className="rounded-2xl border px-2 py-2 flex items-end gap-2"
      data-testid="ai-coach-input-dock"
    >
      <div className="ai-composer-avatar grid place-items-center w-9 h-9 rounded-full text-[11.5px] font-bold shrink-0">
        {initials(studentName || "")}
      </div>

      <textarea
        ref={taRef}
        rows={1}
        value={value}
        onChange={onInput}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        data-testid="ai-coach-input"
        className="flex-1 resize-none bg-transparent outline-none text-[0.875rem] leading-snug py-2 px-1 max-h-[140px]"
      />

      {voiceAvailable && (
        <button
          type="button"
          onClick={listening ? onMicStop : onMicStart}
          disabled={busy || featureDisabled}
          aria-label={listening ? "Stop voice" : "Start voice"}
          data-testid={listening ? "ai-coach-mic-stop-btn" : "ai-coach-mic-btn"}
          className={`ai-composer-mic ${listening ? "ai-composer-mic--listening" : ""} inline-flex items-center justify-center w-10 h-10 rounded-full transition active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>
      )}

      {busy ? (
        <button
          type="button"
          onClick={onStop}
          data-testid="ai-coach-stop-btn"
          aria-label="Stop"
          className="ai-composer-stop inline-flex items-center justify-center w-10 h-10 rounded-full transition active:scale-95"
        >
          <Square className="w-4 h-4" />
        </button>
      ) : (
        <button
          type="button"
          onClick={onSend}
          disabled={sendDisabled}
          data-testid="ai-coach-send-btn"
          aria-label="Send"
          className="ai-composer-send inline-flex items-center justify-center w-10 h-10 rounded-full disabled:cursor-not-allowed transition active:scale-95"
        >
          {needsWalletPw ? <MessageSquare className="w-4 h-4" /> : <Send className="w-4 h-4" />}
        </button>
      )}
    </div>
  );
}
