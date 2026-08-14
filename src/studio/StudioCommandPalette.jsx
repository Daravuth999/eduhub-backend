/**
 * StudioCommandPalette.jsx — Studio OS universal search.
 *
 * SCOPE DECISION (product-polish pass — resolves "is this tool-only or
 * truly universal?"): this is deliberately a UNIVERSAL search, not a tool
 * launcher with a search box bolted on — it is the one search box for the
 * whole of Studio, on desktop and mobile, per the architecture direction.
 * "Universal" is scoped to what real, already-deployed list endpoints can
 * back honestly today, and grows entity-by-entity as more of them do —
 * it is not a claim that every record type in Studio is searchable yet.
 * Concretely in scope right now: every Tool (all 34 tabs, unconditionally,
 * matching the pre-Studio-OS palette's own guarantee) plus four entity
 * types — Students, Books, Coupons, Events — each via the SAME
 * already-deployed list function their own tab already calls
 * (listStudents, listStudioBooks, listCoupons, listEvents). No new backend
 * route. Selecting a tool still calls the SAME `handleTabChange` every
 * existing pill button calls; selecting an entity navigates to the tab
 * that owns it (this codebase has no per-record deep-linking today, so
 * "jump to the right tab" is the honest, additive step — not a fabricated
 * deep link).
 *
 * Deliberately NOT searched here (see studioHomeApi.js's header for the
 * same reasoning applied to Studio Home): Payments transactions,
 * Attendance session detail, AI configuration fields, and "Teachers" —
 * none of these have a simple, already-used list-and-label shape safe to
 * merge into one result list without a dedicated per-entity pass. The
 * input placeholder names the actual four entity types rather than
 * claiming unqualified "search anything", so the UI's own copy never
 * promises more than this file actually searches.
 *
 * Entity lists are fetched ONCE, lazily, the first time the palette is
 * opened in a session (not on every keystroke, not on every open) — cmdk's
 * own built-in fuzzy filter then runs over tools + all fetched entities
 * together, so no manual query-matching code is needed here.
 *
 * Styled with this file's own inline dark/gold aesthetic (Tailwind's
 * `gold`/`walnut`/`parchment`/`ink`/`faded` tokens, defined in
 * tailwind.config.js and already used throughout StudioPage.jsx) rather
 * than the generic shadcn `src/components/ui/command.jsx` wrapper, whose
 * `bg-popover`/`text-muted-foreground` classes resolve against the app's
 * global light-mode shadcn theme (see src/index.css) and would render as
 * a mismatched white dialog inside Studio's dark shell.
 */
import { useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import { Description as DialogDescription } from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Search, GraduationCap, BookOpen, Tag, PartyPopper, Loader2 } from "lucide-react";
import { easing, duration } from "../eduhub/styles/tokens/motionTokens";
import { listStudents } from "../eduhub/auth/studentAuthService";
import { listStudioBooks, listCoupons, listEvents } from "./api";

const ENTITY_GROUPS = [
  { key: "students", label: "Students", icon: GraduationCap, tabKey: "teacher" },
  { key: "books", label: "Books", icon: BookOpen, tabKey: "browse" },
  { key: "coupons", label: "Coupons", icon: Tag, tabKey: "coupons" },
  { key: "events", label: "Events", icon: PartyPopper, tabKey: "eventtemplates" },
];

export default function StudioCommandPalette({ tabs, onSelect }) {
  const [open, setOpen] = useState(false);
  const [entityLoading, setEntityLoading] = useState(false);
  const [entities, setEntities] = useState(null); // null = not yet fetched
  const fetchedRef = useRef(false);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const onKeyDown = (e) => {
      const isMeta = e.metaKey || e.ctrlKey;
      if (!isMeta || e.key.toLowerCase() !== "k") return;

      // Audit fix (independent Phase 0 review) — a plain, ungated `window`
      // listener would fire even while an admin is typing inside any
      // Studio text field, stealing the browser's native Cmd/Ctrl+K there.
      // StudioEditor.jsx's own KeyboardCaptureBridge already established
      // this exact guard for its own shortcuts; matching it here rather
      // than inventing a second convention.
      const t = e.target;
      const isEditable =
        t?.tagName === "INPUT" ||
        t?.tagName === "TEXTAREA" ||
        t?.isContentEditable ||
        t?.getAttribute?.("contenteditable") === "true";
      if (isEditable) return;

      // Audit fix — real z-index collision found: LoginRewardStudio.jsx's
      // push-send confirm dialog renders at z-[1000], above this palette's
      // z-[200]/[201]. An admin mid-confirmation who reflexively hits
      // Ctrl/Cmd+K should not have this palette silently pop up underneath
      // (or, with a higher z-index, ON TOP of and obscuring) an unconfirmed
      // send/payment/delete action. Only gates the OPEN transition — the
      // same shortcut still closes an already-open palette regardless of
      // what else is on screen.
      if (!open) {
        const anotherModalOpen = document.querySelector('[aria-modal="true"]');
        if (anotherModalOpen) return;
      }

      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Lazy, once-per-session entity fetch — only once the admin actually
  // opens search, never eagerly on mount.
  useEffect(() => {
    if (!open || fetchedRef.current) return;
    fetchedRef.current = true;
    setEntityLoading(true);
    Promise.allSettled([listStudents(), listStudioBooks(), listCoupons(), listEvents()])
      .then(([students, books, coupons, events]) => {
        const val = (r) => (r.status === "fulfilled" ? r.value : null);
        const booksRaw = val(books);
        setEntities({
          students: val(students) || [],
          books: Array.isArray(booksRaw) ? booksRaw : booksRaw?.books || [],
          coupons: val(coupons) || [],
          events: val(events) || [],
        });
      })
      .finally(() => setEntityLoading(false));
  }, [open]);

  const handleSelect = (key) => {
    setOpen(false);
    onSelect(key);
  };

  const transition = prefersReducedMotion
    ? { duration: duration.instant }
    : { duration: duration.fast, ease: easing.premiumEaseOut };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="studio-search-trigger"
        aria-label="Search Studio (Ctrl+K)"
        className="inline-flex items-center gap-2 rounded-full border border-gold/25 bg-walnut/70 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden sm:inline-flex items-center rounded border border-parchment/20 px-1.5 text-[9.5px] font-mono normal-case tracking-normal text-faded">
          ⌘K
        </kbd>
      </button>

      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label="Search Studio"
        data-testid="studio-command-palette"
        shouldFilter
        loop
        // Audit fix — z-[200]/[201] originally sat BELOW LoginRewardStudio's
        // z-[1000] push-confirm dialog, the highest z-index anywhere else in
        // Studio (verified via a full grep across src/studio/). The keydown
        // guard above should make the two never open together in the first
        // place; this is the defense-in-depth half of that fix, so the
        // palette structurally outranks every current Studio modal even if
        // the guard's DOM query ever misses a future one.
        overlayClassName="fixed inset-0 z-[1100] bg-ink/70 backdrop-blur-sm"
        contentClassName="fixed left-1/2 top-[14%] -translate-x-1/2 w-[92vw] max-w-[560px] z-[1101]"
      >
        {/* Final audit fix — cmdk's Command.Dialog renders a real Radix
            Dialog.Content under the hood, which always wires its own
            auto-generated `aria-describedby` onto the dialog regardless of
            what we render. Without an actual Dialog.Description sharing
            that id somewhere in this subtree, Radix logs a real a11y
            warning ("Missing Description...") every time the palette
            opens, and screen-reader users get an id that points at
            nothing. This is a visually-hidden child, not a visible label —
            "Search Studio" (the visible trigger's own label) stays the
            user-facing name. */}
        <DialogDescription className="sr-only">
          Search across Studio tools, students, books, coupons, and events.
        </DialogDescription>
        <AnimatePresence>
          {open && (
            <motion.div
              initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.97, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -6 }}
              transition={transition}
              className="overflow-hidden rounded-3xl border border-gold/25"
              style={{ background: "rgba(20,14,32,0.94)", backdropFilter: "blur(14px)" }}
            >
              <div className="flex items-center gap-2.5 border-b border-parchment/10 px-4 py-3.5">
                <Search className="h-4 w-4 text-faded flex-shrink-0" />
                <Command.Input
                  autoFocus
                  placeholder="Search tools, students, books, coupons, events…"
                  data-testid="studio-command-input"
                  className="w-full bg-transparent text-[14px] text-parchment placeholder:text-faded outline-none"
                />
                {entityLoading && <Loader2 className="h-3.5 w-3.5 text-faded animate-spin flex-shrink-0" />}
              </div>
              <Command.List className="max-h-[400px] overflow-y-auto p-2">
                <Command.Empty className="px-3 py-8 text-center text-[12.5px] text-faded">
                  No matches.
                </Command.Empty>

                <Command.Group heading="Tools" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-gold">
                  {tabs.map(({ key, label, Icon }) => (
                    <Command.Item
                      key={key}
                      value={label}
                      onSelect={() => handleSelect(key)}
                      data-testid={`studio-command-item-${key}`}
                      className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] text-parchment/90 cursor-pointer data-[selected=true]:bg-gold/15 data-[selected=true]:text-gold"
                    >
                      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                      <span>{label}</span>
                    </Command.Item>
                  ))}
                </Command.Group>

                {entities && ENTITY_GROUPS.map(({ key: groupKey, label, icon: GroupIcon, tabKey }) => {
                  const items = entities[groupKey] || [];
                  if (items.length === 0) return null;
                  return (
                    <Command.Group
                      key={groupKey}
                      heading={label}
                      className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faded"
                    >
                      {items.slice(0, 200).map((item, i) => {
                        const { id, primary, secondary } = describeEntity(groupKey, item, i);
                        return (
                          <Command.Item
                            key={id}
                            value={`${primary} ${secondary || ""}`}
                            onSelect={() => handleSelect(tabKey)}
                            data-testid={`studio-command-entity-${groupKey}-${id}`}
                            className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] text-parchment/90 cursor-pointer data-[selected=true]:bg-gold/15 data-[selected=true]:text-gold"
                          >
                            <GroupIcon className="h-3.5 w-3.5 flex-shrink-0 text-faded" />
                            <span className="flex-1 min-w-0 truncate">{primary}</span>
                            {secondary && <span className="text-[11px] text-faded flex-shrink-0">{secondary}</span>}
                          </Command.Item>
                        );
                      })}
                    </Command.Group>
                  );
                })}
              </Command.List>
            </motion.div>
          )}
        </AnimatePresence>
      </Command.Dialog>
    </>
  );
}

// Normalizes each entity type's real field names (verified against each
// entity's own owning panel) into a common {id, primary, secondary} shape
// for rendering + cmdk's fuzzy match. Never invents a field that isn't
// actually on the object.
function describeEntity(groupKey, item, i) {
  switch (groupKey) {
    case "students":
      return {
        id: item.clean_id || item.student_id || i,
        primary: item.display_name || item.clean_id || item.student_id || "Student",
        secondary: item.clean_id,
      };
    case "books":
      return {
        id: item.slug || i,
        primary: item.title || item.slug || "Untitled",
        secondary: item.published ? "Live" : "Draft",
      };
    case "coupons":
      return {
        id: item.code || i,
        primary: item.code || "Coupon",
        secondary: item.enabled === false ? "Disabled" : undefined,
      };
    case "events":
      return {
        id: item._id || i,
        primary: item.name || "Event",
        secondary: item.state,
      };
    default:
      return { id: i, primary: String(item), secondary: undefined };
  }
}
