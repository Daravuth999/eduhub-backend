import { useEffect, useState } from "react";

export function useScrollProgress() {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const sTop = document.documentElement.scrollTop;
      const sH = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      setProgress(sH > 0 ? (sTop / sH) * 100 : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return progress;
}
