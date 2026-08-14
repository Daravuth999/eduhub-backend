/**
 * TurnstileWidget — TypeScript declarations companion (v11.0.1)
 *
 * The runtime implementation lives in TurnstileWidget.jsx. This .d.ts
 * sibling exists so TypeScript consumers (e.g. LoginScreen.tsx) can see
 * the prop types and the imperative ref handle. Without this file, TS
 * resolves the .jsx import as `ForwardRefExoticComponent<RefAttributes<any>>`
 * — no props allowed — and the build fails on every <TurnstileWidget theme=…>
 * usage with "Property 'theme' does not exist on type 'IntrinsicAttributes
 * & RefAttributes<any>'".
 *
 * Webpack/CRA still picks the .jsx file at runtime; this declaration is
 * compile-time only.
 */
import { ForwardRefExoticComponent, RefAttributes } from "react";

export interface TurnstileHandle {
  /** Returns the current Turnstile token, or "" if the widget is not ready. */
  getToken: () => string;
  /** Re-renders the challenge so the student can retry after a failure. */
  reset: () => void;
  /** True once turnstile.render() has succeeded for this mount. */
  isReady: () => boolean;
}

export interface TurnstileWidgetProps {
  theme?: "auto" | "dark" | "light";
  size?: "flexible" | "normal" | "compact";
  action?: string;
  cdata?: string;
  onToken?: (token: string) => void;
  onError?: (msg: string) => void;
  className?: string;
}

declare const TurnstileWidget: ForwardRefExoticComponent<
  TurnstileWidgetProps & RefAttributes<TurnstileHandle>
>;

export default TurnstileWidget;
