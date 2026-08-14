/**
 * artworkClickAction.js — resolve a campaign's click_action into a handler.
 *
 * Navigation-only: it never touches EduTalk, audio, wallet or payment
 * internals. The single non-navigation action ("topup") simply asks the
 * caller to open the EXISTING PointsPurchaseModal via the `openTopUp`
 * callback the renderer owns locally (no payment code is modified).
 *
 * Route mapping (fixed, safe):
 *   topup          → openTopUp()                      (local modal)
 *   book           → /library/read/<slug>
 *   collection     → /library[?collection=<key>]
 *   speaking_lab   → /assistant
 *   edutalk        → /assistant
 *   reward         → /game
 *   internal_route → navigate(<value>)
 *   external_url   → window.open(<value>)
 */
export function makeArtworkClickHandler(campaign, { navigate, openTopUp } = {}) {
  const action = campaign?.click_action || {};
  const type = action.type || "internal_route";
  const value = (action.value || "").trim();

  return function handleClick(e) {
    try {
      switch (type) {
        case "topup":
          if (typeof openTopUp === "function") openTopUp(campaign);
          return;
        case "book":
          if (value) navigate?.(`/library/read/${value}`);
          else navigate?.("/library");
          return;
        case "collection":
          navigate?.(value ? `/library?collection=${encodeURIComponent(value)}` : "/library");
          return;
        case "speaking_lab":
          navigate?.("/assistant");
          return;
        case "edutalk":
          navigate?.("/assistant");
          return;
        case "reward":
          navigate?.("/game");
          return;
        case "internal_route":
          navigate?.(value || "/library");
          return;
        case "external_url":
          if (value) {
            const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
            window.open(url, "_blank", "noopener,noreferrer");
          }
          return;
        default:
          navigate?.("/library");
      }
    } catch {
      /* never throw from a click handler */
    }
  };
}
