import { useEffect, useRef } from "react";
import { IDLE_LOGOUT_MS } from "../config/sections";

/** Fires `onIdle` after IDLE_LOGOUT_MS of zero user interaction. */
export function useIdleLogout(onIdle: () => void) {
  const cbRef = useRef(onIdle);
  cbRef.current = onIdle;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cbRef.current(), IDLE_LOGOUT_MS);
    };

    const events = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "scroll",
      "wheel",
    ];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();

    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, []);
}
