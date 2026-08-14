// useKeyboardBodyLock.js — root-cause fix for "the whole page translates
// upward when the keyboard opens" on iOS Safari / installed iOS PWAs.
//
// The symptom (confirmed on real devices): focusing a text input near
// the bottom of the screen causes Safari to auto-scroll the DOCUMENT to
// bring that input into view. Because `position: fixed` elements (the
// app's Header, MobileBottomNav) are anchored to the LAYOUT viewport,
// not the VISUAL viewport, iOS's own long-standing fixed-position-
// during-keyboard bug then drags them along with that scroll — so the
// header, the bottom nav, and the conversation all appear to slide
// upward together, instead of the keyboard simply covering the bottom
// of an otherwise-still page (the ChatGPT/iMessage/WhatsApp behaviour).
//
// Neither a `dvh` viewport unit nor any CSS `position` change can fix
// this — the browser's auto-scroll only has anything to act on if the
// document is actually scrollable. So the fix is architectural: for as
// long as the given element has focus, pin `document.body` in place
// (position: fixed at its current scroll offset, overflow: hidden) so
// there is nothing left for iOS to scroll. Restore the exact scroll
// position on blur. This is the same technique production chat PWAs
// (Slack, WhatsApp Web, etc.) use.
//
// Scoped to a single element ref — NOT a global "every input on the
// page" listener — so it can never affect unrelated forms elsewhere in
// the app (Studio, login, search). Any future chat-style composer can
// adopt the same fix by calling this hook with its own textarea ref.

import { useEffect } from "react";

export default function useKeyboardBodyLock(ref) {
  useEffect(() => {
    const el = ref?.current;
    if (!el || typeof document === "undefined") return undefined;

    let scrollY = 0;
    let locked = false;

    const lock = () => {
      if (locked) return;
      locked = true;
      scrollY = window.scrollY || window.pageYOffset || 0;
      const body = document.body;
      body.style.position = "fixed";
      body.style.top = `-${scrollY}px`;
      body.style.left = "0";
      body.style.right = "0";
      body.style.width = "100%";
      body.style.overflow = "hidden";
    };

    const unlock = () => {
      if (!locked) return;
      locked = false;
      const body = document.body;
      body.style.position = "";
      body.style.top = "";
      body.style.left = "";
      body.style.right = "";
      body.style.width = "";
      body.style.overflow = "";
      window.scrollTo(0, scrollY);
    };

    el.addEventListener("focus", lock);
    el.addEventListener("blur", unlock);
    return () => {
      el.removeEventListener("focus", lock);
      el.removeEventListener("blur", unlock);
      unlock();
    };
  }, [ref]);
}
