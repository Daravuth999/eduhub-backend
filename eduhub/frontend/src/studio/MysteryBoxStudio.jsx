/**
 * MysteryBoxStudio.jsx — Author Studio panel for the Speaking Lab Mystery
 * Box reward system.
 *
 * Scope (additive only):
 *   • Manage EduTalk Pass templates (admin-defined, reusable).
 *   • Manage Mystery Box prize templates (points / book voucher /
 *     EduTalk pass / lucky-draw entry / recognition / consolation).
 *   • Manage Mystery Box campaign instances (the actual classroom
 *     reward setups Speaking Lab teachers can launch).
 *
 * Single source of truth: the EduHub backend. No localStorage.
 * Voucher codes are NEVER exposed in this UI (they live in the
 * coupon collection only).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Gift,
  Plus,
  RefreshCw,
  Trash2,
  Edit3,
  AlertTriangle,
  CheckCircle2,
  X,
  Ticket,
  GraduationCap,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Boxes,
} from "lucide-react";
import {
  listMysteryBoxPrizeTemplates,
  createMysteryBoxPrizeTemplate,
  updateMysteryBoxPrizeTemplate,
  deleteMysteryBoxPrizeTemplate,
  listEduTalkPassTemplates,
  createEduTalkPassTemplate,
  updateEduTalkPassTemplate,
  deleteEduTalkPassTemplate,
  listMysteryBoxCampaigns,
  createMysteryBoxCampaign,
  updateMysteryBoxCampaign,
  deleteMysteryBoxCampaign,
} from "./api";

const PRIZE_TYPES = [
  { key: "points", label: "Points" },
  { key: "book_voucher", label: "Book Voucher" },
  { key: "edutalk_session", label: "EduTalk Session Pass" },
  { key: "edutalk_voice", label: "EduTalk Voice Reply Pass" },
  { key: "lucky_draw_entry", label: "Lucky Draw Entry" },
  { key: "recognition", label: "Recognition Badge" },
  { key: "consolation", label: "Consolation" },
];

const DEFAULT_PRIZE = {
  title: "",
  type: "points",
  subtitle: "",
  accent_color: "#D4A843",
  icon: "gift",
  rarity: "common",
  enabled: true,
  points: 5,
  voucher_discount_type: "percent",
  voucher_discount_value: 20,
  voucher_valid_days: 30,
  voucher_book_slugs: [],
  voucher_title: "",
  voucher_subtitle: "",
  pass_template_id: "",
  quantity: 1,
  expires_in_days: 30,
  eligible_book_slugs: [],
  entries: 1,
  badge_label: "",
  message: "",
};

const DEFAULT_PASS = {
  name: "",
  feature: "edutalk_session",
  quantity_total: 1,
  eligible_book_slugs: [],
  expires_in_days: 30,
  use_pass_before_points: true,
  show_in_portal: true,
  show_in_reader: true,
  enabled: true,
};

const DEFAULT_CAMPAIGN = {
  name: "",
  description: "",
  box_count: 7,
  prize_template_ids: [],
  weighted_layout: false,
  weights: null,
  teacher_confirm_required: true,
  reveal_all_after_claim: true,
  hide_voucher_code: true,
  grant_selected_only: true,
  show_missed_prizes: true,
  enabled: true,
};

function Toolbar({ active, onChange }) {
  const tabs = [
    { key: "prizes", label: "Prize Templates", Icon: Gift },
    { key: "passes", label: "EduTalk Passes", Icon: GraduationCap },
    { key: "campaigns", label: "Campaigns", Icon: Boxes },
  ];
  return (
    <div className="flex flex-wrap gap-1.5 mb-5" data-testid="mb-subtabs">
      {tabs.map(({ key, label, Icon }) => {
        const isActive = active === key;
        return (
          <button
            key={key}
            data-testid={`mb-subtab-${key}`}
            onClick={() => onChange(key)}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all"
            style={{
              background: isActive
                ? "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)"
                : "rgba(45,31,62,0.55)",
              color: isActive ? "#1a1420" : "#F4E5C1",
              border: isActive ? "1px solid rgba(255,225,154,0.6)" : "1px solid rgba(212,168,67,0.25)",
            }}
          >
            <Icon className="h-3 w-3" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Card({ children, className = "" }) {
  return (
    <div
      className={`rounded-2xl border border-gold/20 p-4 ${className}`}
      style={{ background: "rgba(20,14,32,0.65)" }}
    >
      {children}
    </div>
  );
}

function FieldLabel({ children }) {
  return (
    <label className="text-[11px] uppercase tracking-wider text-faded block mb-1">
      {children}
    </label>
  );
}

function TextInput({ value, onChange, placeholder, type = "text", ...rest }) {
  return (
    <input
      type={type}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg border border-gold/25 bg-walnut/60 px-3 py-2 text-[13px] text-parchment placeholder:text-faded focus:outline-none focus:border-gold"
      {...rest}
    />
  );
}

function Select({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-gold/25 bg-walnut/60 px-3 py-2 text-[13px] text-parchment focus:outline-none focus:border-gold"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({ value, onChange, label, testid }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      data-testid={testid}
      className="inline-flex items-center gap-2 text-[12px] text-parchment hover:text-gold"
    >
      {value ? (
        <ToggleRight className="h-5 w-5 text-emerald-400" />
      ) : (
        <ToggleLeft className="h-5 w-5 text-parchment/40" />
      )}
      {label}
    </button>
  );
}

function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      data-testid="mb-error"
      className="mb-4 flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-[12px] text-red-200"
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
      <div className="flex-1">{String(error.message || error)}</div>
      <button onClick={onDismiss} className="text-red-200/70 hover:text-red-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 *  PRIZE TEMPLATES TAB
 * ───────────────────────────────────────────────────────── */
function PrizeTemplatesTab({ passTemplates }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | "new" | row.id
  const [draft, setDraft] = useState(DEFAULT_PRIZE);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listMysteryBoxPrizeTemplates();
      setList(r?.prizes || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startNew = () => {
    setEditing("new");
    setDraft({ ...DEFAULT_PRIZE });
  };

  const startEdit = (row) => {
    setEditing(row.id);
    setDraft({ ...DEFAULT_PRIZE, ...row });
  };

  const save = async () => {
    setLoading(true);
    setError(null);
    try {
      if (editing === "new") {
        await createMysteryBoxPrizeTemplate(draft);
      } else {
        await updateMysteryBoxPrizeTemplate(editing, draft);
      }
      setEditing(null);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm("Delete this prize template?")) return;
    setLoading(true);
    try {
      await deleteMysteryBoxPrizeTemplate(id);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div data-testid="mb-prizes-tab">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[13px] font-bold uppercase tracking-wider text-parchment">
          Prize Templates ({list.length})
        </h3>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            data-testid="mb-prizes-refresh"
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-full border border-gold/25 px-3 py-1.5 text-[11px] uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            onClick={startNew}
            data-testid="mb-prizes-new"
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink"
            style={{
              background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            New Prize
          </button>
        </div>
      </div>

      <div className="grid gap-3 mb-6">
        {list.map((row) => (
          <Card key={row.id}>
            <div className="flex items-start gap-3">
              <div
                className="h-10 w-10 rounded-xl flex items-center justify-center"
                style={{ background: row.accent_color || "#D4A843", color: "#1a1420" }}
              >
                <Gift className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-parchment text-[14px]">{row.title}</span>
                  <span className="text-[10px] uppercase tracking-wider text-faded">
                    {row.type}
                  </span>
                  {row.enabled ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-red-400" />
                  )}
                </div>
                {row.subtitle && (
                  <div className="text-[11px] text-faded mt-0.5">{row.subtitle}</div>
                )}
                <div className="text-[11px] text-faded mt-1">
                  {row.type === "points" && `+${row.points || 0} points`}
                  {row.type === "book_voucher" &&
                    `${row.voucher_discount_value}${row.voucher_discount_type === "percent" ? "%" : " KHR"} off · valid ${row.voucher_valid_days}d`}
                  {(row.type === "edutalk_session" || row.type === "edutalk_voice") &&
                    `${row.quantity || 1}× ${row.type === "edutalk_session" ? "session" : "voice reply"} · ${row.expires_in_days || 30}d`}
                  {row.type === "consolation" && (row.message || "Try again next time")}
                  {row.type === "recognition" && (row.badge_label || "Badge")}
                  {row.type === "lucky_draw_entry" && `+${row.entries || 1} lucky entries`}
                </div>
              </div>
              <button
                data-testid={`mb-prize-edit-${row.id}`}
                onClick={() => startEdit(row)}
                className="rounded-full p-1.5 text-parchment hover:text-gold"
              >
                <Edit3 className="h-4 w-4" />
              </button>
              <button
                data-testid={`mb-prize-delete-${row.id}`}
                onClick={() => remove(row.id)}
                className="rounded-full p-1.5 text-parchment hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </Card>
        ))}
        {list.length === 0 && !loading && (
          <Card>
            <div className="text-center text-[12px] text-faded py-6">
              No prize templates yet. Click <strong>New Prize</strong> to create one.
            </div>
          </Card>
        )}
      </div>

      {editing !== null && (
        <PrizeEditor
          draft={draft}
          setDraft={setDraft}
          passTemplates={passTemplates}
          onSave={save}
          onCancel={() => setEditing(null)}
          loading={loading}
        />
      )}
    </div>
  );
}

function PrizeEditor({ draft, setDraft, passTemplates, onSave, onCancel, loading }) {
  const update = (k, v) => setDraft((p) => ({ ...p, [k]: v }));
  const t = draft.type;
  return (
    <Card className="border-gold/40">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-[13px] font-bold uppercase tracking-wider text-gold">
          {draft.id ? "Edit Prize" : "New Prize"}
        </h4>
        <button
          onClick={onCancel}
          data-testid="mb-prize-editor-close"
          className="text-parchment hover:text-gold"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <FieldLabel>Title</FieldLabel>
          <TextInput
            value={draft.title}
            onChange={(v) => update("title", v)}
            placeholder="e.g. 20% Book Voucher"
            data-testid="mb-prize-input-title"
          />
        </div>
        <div>
          <FieldLabel>Type</FieldLabel>
          <Select
            value={t}
            onChange={(v) => update("type", v)}
            options={PRIZE_TYPES.map((o) => ({ value: o.key, label: o.label }))}
          />
        </div>
        <div className="sm:col-span-2">
          <FieldLabel>Subtitle (optional)</FieldLabel>
          <TextInput
            value={draft.subtitle}
            onChange={(v) => update("subtitle", v)}
            placeholder="Short tagline shown on the reveal modal"
          />
        </div>

        {t === "points" && (
          <div>
            <FieldLabel>Points</FieldLabel>
            <TextInput
              type="number"
              value={draft.points}
              onChange={(v) => update("points", Number(v) || 0)}
            />
          </div>
        )}

        {t === "book_voucher" && (
          <>
            <div>
              <FieldLabel>Discount type</FieldLabel>
              <Select
                value={draft.voucher_discount_type}
                onChange={(v) => update("voucher_discount_type", v)}
                options={[
                  { value: "percent", label: "Percent (%)" },
                  { value: "amount", label: "Amount (KHR)" },
                ]}
              />
            </div>
            <div>
              <FieldLabel>Discount value</FieldLabel>
              <TextInput
                type="number"
                value={draft.voucher_discount_value}
                onChange={(v) => update("voucher_discount_value", Number(v) || 0)}
              />
            </div>
            <div>
              <FieldLabel>Valid for (days)</FieldLabel>
              <TextInput
                type="number"
                value={draft.voucher_valid_days}
                onChange={(v) => update("voucher_valid_days", Number(v) || 30)}
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Eligible book slugs (comma-separated; empty = all)</FieldLabel>
              <TextInput
                value={(draft.voucher_book_slugs || []).join(",")}
                onChange={(v) =>
                  update(
                    "voucher_book_slugs",
                    v.split(",").map((s) => s.trim()).filter(Boolean),
                  )
                }
                placeholder="book-alpha,book-beta"
              />
            </div>
          </>
        )}

        {(t === "edutalk_session" || t === "edutalk_voice") && (
          <>
            <div>
              <FieldLabel>Reuse Pass Template (optional)</FieldLabel>
              <Select
                value={draft.pass_template_id || ""}
                onChange={(v) => update("pass_template_id", v)}
                options={[
                  { value: "", label: "— inline configuration —" },
                  ...passTemplates
                    .filter((p) => p.feature === t)
                    .map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </div>
            <div>
              <FieldLabel>Quantity</FieldLabel>
              <TextInput
                type="number"
                value={draft.quantity}
                onChange={(v) => update("quantity", Number(v) || 1)}
              />
            </div>
            <div>
              <FieldLabel>Expires in (days)</FieldLabel>
              <TextInput
                type="number"
                value={draft.expires_in_days}
                onChange={(v) => update("expires_in_days", Number(v) || 30)}
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Eligible book slugs (comma-separated; empty = all)</FieldLabel>
              <TextInput
                value={(draft.eligible_book_slugs || []).join(",")}
                onChange={(v) =>
                  update(
                    "eligible_book_slugs",
                    v.split(",").map((s) => s.trim()).filter(Boolean),
                  )
                }
              />
            </div>
          </>
        )}

        {t === "lucky_draw_entry" && (
          <div>
            <FieldLabel>Entries</FieldLabel>
            <TextInput
              type="number"
              value={draft.entries}
              onChange={(v) => update("entries", Number(v) || 1)}
            />
          </div>
        )}

        {t === "recognition" && (
          <div className="sm:col-span-2">
            <FieldLabel>Badge label</FieldLabel>
            <TextInput
              value={draft.badge_label}
              onChange={(v) => update("badge_label", v)}
              placeholder="Confidence Star"
            />
          </div>
        )}

        {t === "consolation" && (
          <>
            <div>
              <FieldLabel>Bonus points (optional)</FieldLabel>
              <TextInput
                type="number"
                value={draft.points}
                onChange={(v) => update("points", Number(v) || 0)}
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Message</FieldLabel>
              <TextInput
                value={draft.message}
                onChange={(v) => update("message", v)}
                placeholder="Almost lucky — try again next time"
              />
            </div>
          </>
        )}

        <div>
          <FieldLabel>Accent color</FieldLabel>
          <TextInput
            value={draft.accent_color}
            onChange={(v) => update("accent_color", v)}
            placeholder="#D4A843"
          />
        </div>
        <div>
          <FieldLabel>Rarity</FieldLabel>
          <Select
            value={draft.rarity}
            onChange={(v) => update("rarity", v)}
            options={[
              { value: "common", label: "Common" },
              { value: "rare", label: "Rare" },
              { value: "epic", label: "Epic" },
              { value: "legendary", label: "Legendary" },
            ]}
          />
        </div>
        <div className="sm:col-span-2 flex items-center gap-3">
          <Toggle
            value={draft.enabled}
            onChange={(v) => update("enabled", v)}
            label="Enabled"
            testid="mb-prize-enabled"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button
          onClick={onCancel}
          className="rounded-full border border-parchment/20 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          data-testid="mb-prize-save"
          disabled={loading || !draft.title}
          className="rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink disabled:opacity-50"
          style={{
            background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
          }}
        >
          {loading ? "Saving…" : "Save"}
        </button>
      </div>
    </Card>
  );
}

/* ─────────────────────────────────────────────────────────
 *  EDUTALK PASS TEMPLATES TAB
 * ───────────────────────────────────────────────────────── */
function EduTalkPassTemplatesTab({ onChange }) {
  const [list, setList] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(DEFAULT_PASS);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listEduTalkPassTemplates();
      setList(r?.templates || []);
      onChange?.(r?.templates || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [onChange]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startNew = () => {
    setEditing("new");
    setDraft({ ...DEFAULT_PASS });
  };
  const startEdit = (row) => {
    setEditing(row.id);
    setDraft({ ...DEFAULT_PASS, ...row });
  };
  const save = async () => {
    setLoading(true);
    setError(null);
    try {
      if (editing === "new") await createEduTalkPassTemplate(draft);
      else await updateEduTalkPassTemplate(editing, draft);
      setEditing(null);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  const remove = async (id) => {
    if (!window.confirm("Delete this pass template?")) return;
    setLoading(true);
    try {
      await deleteEduTalkPassTemplate(id);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div data-testid="mb-passes-tab">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[13px] font-bold uppercase tracking-wider text-parchment">
          EduTalk Pass Templates ({list.length})
        </h3>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            data-testid="mb-passes-refresh"
            className="inline-flex items-center gap-1.5 rounded-full border border-gold/25 px-3 py-1.5 text-[11px] uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            onClick={startNew}
            data-testid="mb-passes-new"
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink"
            style={{
              background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            New Pass Template
          </button>
        </div>
      </div>

      <div className="grid gap-3 mb-6">
        {list.map((row) => (
          <Card key={row.id}>
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-xl flex items-center justify-center bg-purple-700/30 text-purple-300">
                <Ticket className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-parchment text-[14px]">{row.name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-faded">
                    {row.feature}
                  </span>
                  {row.enabled ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-red-400" />
                  )}
                </div>
                <div className="text-[11px] text-faded mt-0.5">
                  Qty {row.quantity_total} · expires {row.expires_in_days}d ·{" "}
                  {(row.eligible_book_slugs || []).length === 0
                    ? "all books"
                    : (row.eligible_book_slugs || []).join(", ")}
                </div>
              </div>
              <button
                onClick={() => startEdit(row)}
                data-testid={`mb-pass-edit-${row.id}`}
                className="rounded-full p-1.5 text-parchment hover:text-gold"
              >
                <Edit3 className="h-4 w-4" />
              </button>
              <button
                onClick={() => remove(row.id)}
                data-testid={`mb-pass-delete-${row.id}`}
                className="rounded-full p-1.5 text-parchment hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </Card>
        ))}
        {list.length === 0 && !loading && (
          <Card>
            <div className="text-center text-[12px] text-faded py-6">
              No pass templates yet.
            </div>
          </Card>
        )}
      </div>

      {editing !== null && (
        <Card className="border-gold/40">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-[13px] font-bold uppercase tracking-wider text-gold">
              {draft.id ? "Edit Pass Template" : "New Pass Template"}
            </h4>
            <button onClick={() => setEditing(null)} className="text-parchment hover:text-gold">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <FieldLabel>Name</FieldLabel>
              <TextInput
                value={draft.name}
                onChange={(v) => setDraft((p) => ({ ...p, name: v }))}
                placeholder="1× Free EduTalk Session"
                data-testid="mb-pass-input-name"
              />
            </div>
            <div>
              <FieldLabel>Feature</FieldLabel>
              <Select
                value={draft.feature}
                onChange={(v) => setDraft((p) => ({ ...p, feature: v }))}
                options={[
                  { value: "edutalk_session", label: "EduTalk Session" },
                  { value: "edutalk_voice", label: "EduTalk Voice Reply" },
                ]}
              />
            </div>
            <div>
              <FieldLabel>Quantity (uses per pass)</FieldLabel>
              <TextInput
                type="number"
                value={draft.quantity_total}
                onChange={(v) =>
                  setDraft((p) => ({ ...p, quantity_total: Math.max(1, Number(v) || 1) }))
                }
              />
            </div>
            <div>
              <FieldLabel>Expires in (days)</FieldLabel>
              <TextInput
                type="number"
                value={draft.expires_in_days}
                onChange={(v) =>
                  setDraft((p) => ({ ...p, expires_in_days: Math.max(1, Number(v) || 30) }))
                }
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Eligible book slugs (comma-separated; empty = all books)</FieldLabel>
              <TextInput
                value={(draft.eligible_book_slugs || []).join(",")}
                onChange={(v) =>
                  setDraft((p) => ({
                    ...p,
                    eligible_book_slugs: v
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }))
                }
              />
            </div>
            <div className="flex items-center gap-4 sm:col-span-2">
              <Toggle
                value={draft.use_pass_before_points}
                onChange={(v) => setDraft((p) => ({ ...p, use_pass_before_points: v }))}
                label="Use pass before points"
                testid="mb-pass-use-before"
              />
              <Toggle
                value={draft.show_in_portal}
                onChange={(v) => setDraft((p) => ({ ...p, show_in_portal: v }))}
                label="Show in My Portal"
                testid="mb-pass-show-portal"
              />
              <Toggle
                value={draft.show_in_reader}
                onChange={(v) => setDraft((p) => ({ ...p, show_in_reader: v }))}
                label="Show in Reader"
                testid="mb-pass-show-reader"
              />
              <Toggle
                value={draft.enabled}
                onChange={(v) => setDraft((p) => ({ ...p, enabled: v }))}
                label="Enabled"
                testid="mb-pass-enabled"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setEditing(null)}
              className="rounded-full border border-parchment/20 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
            >
              Cancel
            </button>
            <button
              onClick={save}
              data-testid="mb-pass-save"
              disabled={loading || !draft.name}
              className="rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink disabled:opacity-50"
              style={{
                background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
              }}
            >
              {loading ? "Saving…" : "Save"}
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 *  CAMPAIGNS TAB
 * ───────────────────────────────────────────────────────── */
function CampaignsTab({ prizes }) {
  const [list, setList] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(DEFAULT_CAMPAIGN);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listMysteryBoxCampaigns();
      setList(r?.campaigns || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startNew = () => {
    setEditing("new");
    setDraft({ ...DEFAULT_CAMPAIGN });
  };
  const startEdit = (row) => {
    setEditing(row.id);
    setDraft({ ...DEFAULT_CAMPAIGN, ...row });
  };
  const save = async () => {
    setLoading(true);
    setError(null);
    try {
      if (editing === "new") await createMysteryBoxCampaign(draft);
      else await updateMysteryBoxCampaign(editing, draft);
      setEditing(null);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  const remove = async (id) => {
    if (!window.confirm("Delete this campaign?")) return;
    setLoading(true);
    try {
      await deleteMysteryBoxCampaign(id);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  const togglePrize = (pid) => {
    setDraft((p) => {
      const next = new Set(p.prize_template_ids || []);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return { ...p, prize_template_ids: Array.from(next) };
    });
  };

  return (
    <div data-testid="mb-campaigns-tab">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[13px] font-bold uppercase tracking-wider text-parchment">
          Mystery Box Campaigns ({list.length})
        </h3>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            data-testid="mb-campaigns-refresh"
            className="inline-flex items-center gap-1.5 rounded-full border border-gold/25 px-3 py-1.5 text-[11px] uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            onClick={startNew}
            data-testid="mb-campaigns-new"
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink"
            style={{
              background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            New Campaign
          </button>
        </div>
      </div>

      <div className="grid gap-3 mb-6">
        {list.map((row) => (
          <Card key={row.id}>
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-xl flex items-center justify-center bg-gold/15 text-gold">
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-parchment text-[14px]">{row.name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-faded">
                    {row.box_count} boxes
                  </span>
                  {row.enabled ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-red-400" />
                  )}
                </div>
                <div className="text-[11px] text-faded mt-1">
                  {row.prize_template_ids?.length || 0} prize templates · campaign id{" "}
                  <code className="text-parchment/80">{row.id}</code>
                </div>
              </div>
              <button
                onClick={() => startEdit(row)}
                data-testid={`mb-campaign-edit-${row.id}`}
                className="rounded-full p-1.5 text-parchment hover:text-gold"
              >
                <Edit3 className="h-4 w-4" />
              </button>
              <button
                onClick={() => remove(row.id)}
                data-testid={`mb-campaign-delete-${row.id}`}
                className="rounded-full p-1.5 text-parchment hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </Card>
        ))}
        {list.length === 0 && !loading && (
          <Card>
            <div className="text-center text-[12px] text-faded py-6">No campaigns yet.</div>
          </Card>
        )}
      </div>

      {editing !== null && (
        <Card className="border-gold/40">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-[13px] font-bold uppercase tracking-wider text-gold">
              {draft.id ? "Edit Campaign" : "New Campaign"}
            </h4>
            <button onClick={() => setEditing(null)} className="text-parchment hover:text-gold">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <FieldLabel>Campaign name</FieldLabel>
              <TextInput
                value={draft.name}
                onChange={(v) => setDraft((p) => ({ ...p, name: v }))}
                placeholder="Speaking Lab — Week of Feb 3"
                data-testid="mb-campaign-input-name"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Description (optional)</FieldLabel>
              <TextInput
                value={draft.description}
                onChange={(v) => setDraft((p) => ({ ...p, description: v }))}
                placeholder="Optional notes for the teacher"
              />
            </div>
            <div>
              <FieldLabel>Box count (3–9)</FieldLabel>
              <TextInput
                type="number"
                value={draft.box_count}
                onChange={(v) =>
                  setDraft((p) => ({ ...p, box_count: Math.max(3, Math.min(9, Number(v) || 7)) }))
                }
              />
            </div>
            <div className="flex flex-col gap-2">
              <Toggle
                value={draft.enabled}
                onChange={(v) => setDraft((p) => ({ ...p, enabled: v }))}
                label="Campaign enabled"
                testid="mb-campaign-enabled"
              />
              <Toggle
                value={draft.teacher_confirm_required}
                onChange={(v) => setDraft((p) => ({ ...p, teacher_confirm_required: v }))}
                label="Teacher must confirm reveal"
                testid="mb-campaign-confirm"
              />
              <Toggle
                value={draft.reveal_all_after_claim}
                onChange={(v) => setDraft((p) => ({ ...p, reveal_all_after_claim: v }))}
                label="Reveal all boxes after claim"
                testid="mb-campaign-reveal-all"
              />
              <Toggle
                value={draft.show_missed_prizes}
                onChange={(v) => setDraft((p) => ({ ...p, show_missed_prizes: v }))}
                label="Show missed prizes"
                testid="mb-campaign-show-missed"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>
                Approved prizes ({draft.prize_template_ids?.length || 0} selected)
              </FieldLabel>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[260px] overflow-y-auto pr-1">
                {prizes.map((p) => {
                  const selected = (draft.prize_template_ids || []).includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => togglePrize(p.id)}
                      data-testid={`mb-campaign-prize-toggle-${p.id}`}
                      className={`text-left rounded-lg border px-3 py-2 text-[12px] transition ${
                        selected
                          ? "border-gold text-gold bg-gold/10"
                          : "border-parchment/20 text-parchment/80 hover:border-gold/40"
                      }`}
                    >
                      <div className="font-semibold">{p.title}</div>
                      <div className="text-[10px] uppercase tracking-wider opacity-70">
                        {p.type}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setEditing(null)}
              className="rounded-full border border-parchment/20 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-parchment hover:border-gold hover:text-gold"
            >
              Cancel
            </button>
            <button
              onClick={save}
              data-testid="mb-campaign-save"
              disabled={loading || !draft.name || !(draft.prize_template_ids || []).length}
              className="rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-ink disabled:opacity-50"
              style={{
                background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
              }}
            >
              {loading ? "Saving…" : "Save Campaign"}
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 *  ROOT
 * ───────────────────────────────────────────────────────── */
export default function MysteryBoxStudio() {
  const [active, setActive] = useState("prizes");
  const [passTemplates, setPassTemplates] = useState([]);
  const [prizes, setPrizes] = useState([]);

  // Pre-load lists so the Campaign editor can show prize/pass pickers
  // without forcing the user to bounce between tabs first.
  useEffect(() => {
    (async () => {
      try {
        const [p, t] = await Promise.all([
          listMysteryBoxPrizeTemplates().catch(() => ({ prizes: [] })),
          listEduTalkPassTemplates().catch(() => ({ templates: [] })),
        ]);
        setPrizes(p?.prizes || []);
        setPassTemplates(t?.templates || []);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  return (
    <div data-testid="mystery-box-studio" className="text-parchment">
      <header className="mb-5">
        <h2 className="font-display text-2xl flex items-center gap-2">
          <Boxes className="h-5 w-5 text-gold" />
          Mystery Box & EduTalk Passes
        </h2>
        <p className="text-[12px] text-faded mt-1 max-w-2xl">
          Configure the prize pool and EduTalk passes that the Speaking Lab Mystery Box game
          can grant. Vouchers and passes land privately in each winning student&apos;s My Portal —
          no public codes are ever shown in Speaking Lab.
        </p>
      </header>
      <Toolbar active={active} onChange={setActive} />
      {active === "prizes" && <PrizeTemplatesTab passTemplates={passTemplates} />}
      {active === "passes" && (
        <EduTalkPassTemplatesTab onChange={(t) => setPassTemplates(t)} />
      )}
      {active === "campaigns" && <CampaignsTab prizes={prizes} />}
    </div>
  );
}
