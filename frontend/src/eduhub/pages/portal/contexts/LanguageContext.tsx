import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Lang } from "../types";
import { COPY, tpl, type CopyKey } from "../config/copy";
import { localiseNumber } from "../lib/numerals";

interface LangContextValue {
  lang: Lang;
  toggle: () => void;
  setLang: (l: Lang) => void;
  t: (key: CopyKey) => string;
  /** Fill in a template like `"Hi {name}"` with values. */
  tpl: (template: string, values: Record<string, string | number>) => string;
  /** Localise a number into Khmer numerals when in km mode. */
  num: (n: number | string) => string;
}

const LangContext = createContext<LangContextValue | null>(null);
const KEY = "myportal-lang";

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    if (typeof window === "undefined") return "en";
    const saved = localStorage.getItem(KEY) as Lang | null;
    if (saved === "en" || saved === "km") return saved;
    // Default to Khmer if browser language matches; otherwise English.
    const nav = navigator.language?.toLowerCase() ?? "";
    return nav.startsWith("km") ? "km" : "en";
  });

  useEffect(() => {
    localStorage.setItem(KEY, lang);
    document.documentElement.lang = lang === "km" ? "km" : "en";
  }, [lang]);

  const value = useMemo<LangContextValue>(
    () => ({
      lang,
      toggle: () => setLang((l) => (l === "en" ? "km" : "en")),
      setLang,
      t: (key: CopyKey) => COPY[key][lang] ?? COPY[key].en,
      tpl,
      num: (n) => localiseNumber(n, lang),
    }),
    [lang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used inside <LanguageProvider>");
  return ctx;
}
