/**
 * ReferralConfig.jsx — Author Studio · Referral Program tab.
 *
 * Lets the studio admin:
 *   - Enable / disable referral program
 *   - Show / hide student dashboard referral card
 *   - Configure reward points, minimum payment USD, qualifying trigger,
 *     monthly cap, display message, terms message
 *   - View Referral Leads with status filter
 *   - View Reward history
 *   - Manually mark a class payment confirmed (idempotent reward path)
 *   - Update a lead's status, contact, linked_student_id
 *
 * Uses the additive admin routes registered by backend/referral_tools.py.
 * The component is fully self-contained — no edits to other studio files
 * apart from registering the tab in StudioPage.jsx.
 */
import { useEffect, useMemo, useState } from "react";
import {
  adminGetReferralConfig,
  adminSetReferralConfig,
  adminListReferralLeads,
  adminUpdateReferralLead,
  adminMarkClassPaid,
  adminListReferralRewards,
} from "../eduhub/lib/referralApi";

const STATUS_OPTIONS = [
  "new", "contacted", "paid", "account_created",
  "rewarded", "rejected", "duplicate",
];

export default function ReferralConfig() {
  const [cfg, setCfg] = useState(null);
  const [cfgError, setCfgError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  const [leads, setLeads] = useState([]);
  const [leadsError, setLeadsError] = useState("");
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [leadStatusFilter, setLeadStatusFilter] = useState("");

  const [rewards, setRewards] = useState([]);
  const [rewardsError, setRewardsError] = useState("");
  const [rewardsLoading, setRewardsLoading] = useState(true);

  /* Load config */
  useEffect(() => {
    (async () => {
      try {
        const c = await adminGetReferralConfig();
        setCfg(c);
      } catch (e) {
        setCfgError(e?.message || "Failed to load config");
      }
    })();
  }, []);

  /* Load leads (and reload when filter changes) */
  const refreshLeads = async (filter = leadStatusFilter) => {
    setLeadsLoading(true);
    try {
      const r = await adminListReferralLeads({ status: filter || undefined, limit: 200 });
      setLeads(r?.items || []);
      setLeadsError("");
    } catch (e) {
      setLeadsError(e?.message || "Failed to load leads");
    } finally {
      setLeadsLoading(false);
    }
  };
  useEffect(() => { refreshLeads(); /* eslint-disable-line */ }, [leadStatusFilter]);

  /* Load rewards */
  const refreshRewards = async () => {
    setRewardsLoading(true);
    try {
      const r = await adminListReferralRewards({ limit: 200 });
      setRewards(r?.items || []);
      setRewardsError("");
    } catch (e) {
      setRewardsError(e?.message || "Failed to load rewards");
    } finally {
      setRewardsLoading(false);
    }
  };
  useEffect(() => { refreshRewards(); }, []);

  const setField = (k, v) => setCfg((c) => ({ ...(c || {}), [k]: v }));

  const onSave = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      const next = await adminSetReferralConfig({
        enabled: !!cfg.enabled,
        show_dashboard_card: cfg.show_dashboard_card !== false,
        reward_type: "points",
        reward_points: Number(cfg.reward_points || 0),
        minimum_payment_usd: Number(cfg.minimum_payment_usd || 0),
        qualifying_trigger: cfg.qualifying_trigger || "both",
        monthly_cap: Number(cfg.monthly_cap || 0),
        referral_display_message: cfg.referral_display_message || "",
        terms_message: cfg.terms_message || "",
      });
      setCfg(next);
      setSavedAt(Date.now());
      setCfgError("");
    } catch (e) {
      setCfgError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="text-parchment" data-testid="studio-referral-tab">
      <h2 className="font-display text-[22px] mb-3" style={{ color: "#FFE19A" }}>
        Referral Program
      </h2>
      <p className="text-[12px] text-faded mb-5 max-w-[640px]">
        Default is OFF for safety. When disabled, the student dashboard card
        either hides or shows a paused message, and no reward is credited.
        Reward credit is idempotent — repeated qualifying events for the same
        invited student cannot double-pay the referrer.
      </p>

      {cfgError && (
        <div className="mb-4 rounded-lg border border-red-400/40 bg-red-900/20 px-3 py-2 text-[12px]"
             data-testid="studio-referral-config-error">
          {cfgError}
        </div>
      )}

      {!cfg ? (
        <div className="text-[12px] text-faded">Loading config…</div>
      ) : (
        <ConfigForm
          cfg={cfg}
          setField={setField}
          onSave={onSave}
          saving={saving}
          savedAt={savedAt}
        />
      )}

      <hr className="my-6 border-white/8" />

      <div className="flex items-center gap-3 mb-3">
        <h3 className="font-display text-[18px]" style={{ color: "#FFE19A" }}>
          Referral Leads
        </h3>
        <select
          value={leadStatusFilter}
          onChange={(e) => setLeadStatusFilter(e.target.value)}
          data-testid="studio-referral-leads-filter"
          className="rounded-full border border-parchment/20 bg-walnut/70 px-3 py-1 text-[11px] uppercase tracking-wider"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button
          type="button"
          onClick={() => refreshLeads()}
          className="rounded-full border border-parchment/20 bg-walnut/70 px-3 py-1 text-[11px] uppercase tracking-wider"
          data-testid="studio-referral-leads-refresh"
        >
          Refresh
        </button>
      </div>

      {leadsError && (
        <div className="mb-3 rounded-lg border border-red-400/40 bg-red-900/20 px-3 py-2 text-[12px]"
             data-testid="studio-referral-leads-error">
          {leadsError}
        </div>
      )}

      <LeadsTable
        leads={leads}
        loading={leadsLoading}
        onChanged={refreshLeads}
      />

      <hr className="my-6 border-white/8" />

      <div className="flex items-center gap-3 mb-3">
        <h3 className="font-display text-[18px]" style={{ color: "#FFE19A" }}>
          Reward History
        </h3>
        <button
          type="button"
          onClick={refreshRewards}
          className="rounded-full border border-parchment/20 bg-walnut/70 px-3 py-1 text-[11px] uppercase tracking-wider"
          data-testid="studio-referral-rewards-refresh"
        >
          Refresh
        </button>
      </div>

      {rewardsError && (
        <div className="mb-3 rounded-lg border border-red-400/40 bg-red-900/20 px-3 py-2 text-[12px]"
             data-testid="studio-referral-rewards-error">
          {rewardsError}
        </div>
      )}

      <RewardsTable rewards={rewards} loading={rewardsLoading} />
    </div>
  );
}

function ConfigForm({ cfg, setField, onSave, saving, savedAt }) {
  return (
    <div className="rounded-2xl p-4 sm:p-5 border border-white/8 bg-walnut/40"
         data-testid="studio-referral-config">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ToggleRow
          label="Enable referral program"
          hint="Master switch. When OFF, no reward is credited."
          checked={!!cfg.enabled}
          onChange={(v) => setField("enabled", v)}
          testid="cfg-enabled"
        />
        <ToggleRow
          label="Show dashboard card"
          hint="Hide entirely if you don't want students to see it."
          checked={cfg.show_dashboard_card !== false}
          onChange={(v) => setField("show_dashboard_card", v)}
          testid="cfg-show-card"
        />
        <NumberField
          label="Reward points per qualified friend"
          value={cfg.reward_points}
          onChange={(v) => setField("reward_points", v)}
          min={0} step={1}
          testid="cfg-reward-points"
        />
        <NumberField
          label="Minimum qualifying payment (USD)"
          value={cfg.minimum_payment_usd}
          onChange={(v) => setField("minimum_payment_usd", v)}
          min={0} step={0.25}
          testid="cfg-min-payment"
        />
        <SelectField
          label="Qualifying trigger"
          value={cfg.qualifying_trigger || "both"}
          onChange={(v) => setField("qualifying_trigger", v)}
          options={[
            { value: "class",  label: "Class payment only" },
            { value: "points", label: "Points purchase only" },
            { value: "both",   label: "Both" },
          ]}
          testid="cfg-trigger"
        />
        <NumberField
          label="Monthly cap (rewards per referrer per month)"
          value={cfg.monthly_cap}
          onChange={(v) => setField("monthly_cap", v)}
          min={0} step={1}
          testid="cfg-monthly-cap"
        />
        <TextField
          label="Display message"
          value={cfg.referral_display_message || ""}
          onChange={(v) => setField("referral_display_message", v)}
          testid="cfg-display"
          wide
        />
        <TextField
          label="Terms / explanation"
          value={cfg.terms_message || ""}
          onChange={(v) => setField("terms_message", v)}
          testid="cfg-terms"
          wide
        />
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          data-testid="studio-referral-save-btn"
          className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-bold uppercase tracking-wider disabled:opacity-60"
          style={{
            background: "linear-gradient(135deg, #FFE19A 0%, #D4A843 50%, #9C7A2C 100%)",
            color: "#1a1420",
          }}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {savedAt > 0 && (
          <span className="text-[11px] text-faded" data-testid="studio-referral-saved-at">
            Saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange, testid }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer" data-testid={testid}>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-amber-400"
      />
      <span>
        <div className="text-[13px] font-bold">{label}</div>
        {hint && <div className="text-[11px] text-faded">{hint}</div>}
      </span>
    </label>
  );
}

function NumberField({ label, value, onChange, min = 0, step = 1, testid }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-faded mb-1">{label}</div>
      <input
        type="number"
        value={value ?? ""}
        min={min}
        step={step}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        data-testid={testid}
        className="w-full rounded-lg border border-parchment/20 bg-walnut/60 px-3 py-2 text-[13px] outline-none"
      />
    </label>
  );
}

function TextField({ label, value, onChange, testid, wide }) {
  return (
    <label className={`block ${wide ? "md:col-span-2" : ""}`}>
      <div className="text-[11px] uppercase tracking-wider text-faded mb-1">{label}</div>
      <input
        type="text"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        className="w-full rounded-lg border border-parchment/20 bg-walnut/60 px-3 py-2 text-[13px] outline-none"
      />
    </label>
  );
}

function SelectField({ label, value, onChange, options, testid }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-faded mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        className="w-full rounded-lg border border-parchment/20 bg-walnut/60 px-3 py-2 text-[13px] outline-none"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function LeadsTable({ leads, loading, onChanged }) {
  if (loading) return <div className="text-[12px] text-faded">Loading leads…</div>;
  if (!leads.length) return <div className="text-[12px] text-faded" data-testid="studio-referral-leads-empty">No leads yet.</div>;
  return (
    <div className="overflow-x-auto rounded-xl border border-white/8" data-testid="studio-referral-leads-table">
      <table className="min-w-full text-[12px]">
        <thead className="bg-walnut/60 text-faded uppercase tracking-wider">
          <tr>
            <th className="px-3 py-2 text-left">Created</th>
            <th className="px-3 py-2 text-left">Name</th>
            <th className="px-3 py-2 text-left">Contact</th>
            <th className="px-3 py-2 text-left">Interest</th>
            <th className="px-3 py-2 text-left">Code</th>
            <th className="px-3 py-2 text-left">Referrer</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-left">Actions</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => (
            <LeadRow key={l.id} lead={l} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LeadRow({ lead, onChanged }) {
  const [status, setStatus] = useState(lead.status || "new");
  const [linked, setLinked] = useState(lead.linked_student_id || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const saveLead = async (patch) => {
    setBusy(true); setErr("");
    try {
      await adminUpdateReferralLead(lead.id, patch);
      await onChanged();
    } catch (e) {
      setErr(e?.message || "Update failed");
    } finally { setBusy(false); }
  };

  const markClassPaid = async () => {
    setBusy(true); setErr("");
    try {
      // Default to "minimum" amount — backend re-validates against config.
      await adminMarkClassPaid(lead.id, {
        payment_amount_usd: 99,
        payment_reference: `manual-class:${lead.id}`,
      });
      await onChanged();
    } catch (e) {
      setErr(e?.message || "Class confirmation failed");
    } finally { setBusy(false); }
  };

  const created = useMemo(() => {
    try { return new Date(lead.created_at).toLocaleString(); } catch { return lead.created_at || ""; }
  }, [lead.created_at]);

  return (
    <tr className="border-t border-white/8" data-testid={`studio-referral-lead-row-${lead.id}`}>
      <td className="px-3 py-2 whitespace-nowrap">{created}</td>
      <td className="px-3 py-2">{lead.name}</td>
      <td className="px-3 py-2">{lead.contact}</td>
      <td className="px-3 py-2">{lead.interest}</td>
      <td className="px-3 py-2 font-mono">{lead.referral_code}</td>
      <td className="px-3 py-2">{lead.referrer_id || "—"}</td>
      <td className="px-3 py-2">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-parchment/20 bg-walnut/60 px-2 py-1 text-[11px]"
          data-testid={`lead-status-select-${lead.id}`}
        >
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <input
              type="text"
              placeholder="linked student_id"
              value={linked}
              onChange={(e) => setLinked(e.target.value)}
              data-testid={`lead-link-input-${lead.id}`}
              className="rounded-md border border-parchment/20 bg-walnut/60 px-2 py-1 text-[11px] w-32"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => saveLead({ status, linked_student_id: linked })}
              data-testid={`lead-save-${lead.id}`}
              className="rounded-md border border-parchment/20 bg-walnut/70 px-2 py-1 text-[11px] uppercase tracking-wider"
            >
              Save
            </button>
          </div>
          <button
            type="button"
            disabled={busy || (lead.status || "").toLowerCase() === "rewarded"}
            onClick={markClassPaid}
            data-testid={`lead-mark-class-paid-${lead.id}`}
            className="rounded-md border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-[11px] uppercase tracking-wider"
          >
            Mark class paid
          </button>
          {err && <div className="text-[10.5px] text-red-300">{err}</div>}
        </div>
      </td>
    </tr>
  );
}

function RewardsTable({ rewards, loading }) {
  if (loading) return <div className="text-[12px] text-faded">Loading rewards…</div>;
  if (!rewards.length) return <div className="text-[12px] text-faded" data-testid="studio-referral-rewards-empty">No reward history yet.</div>;
  return (
    <div className="overflow-x-auto rounded-xl border border-white/8" data-testid="studio-referral-rewards-table">
      <table className="min-w-full text-[12px]">
        <thead className="bg-walnut/60 text-faded uppercase tracking-wider">
          <tr>
            <th className="px-3 py-2 text-left">Created</th>
            <th className="px-3 py-2 text-left">Referrer</th>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Amount USD</th>
            <th className="px-3 py-2 text-left">Points</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-left">Rewarded at</th>
          </tr>
        </thead>
        <tbody>
          {rewards.map((r) => (
            <tr key={r.id} className="border-t border-white/8" data-testid={`reward-row-${r.id}`}>
              <td className="px-3 py-2 whitespace-nowrap">{r.created_at || ""}</td>
              <td className="px-3 py-2">{r.referrer_id || "—"}</td>
              <td className="px-3 py-2">{r.qualifying_payment_type}</td>
              <td className="px-3 py-2">{Number(r.qualifying_payment_amount || 0).toFixed(2)}</td>
              <td className="px-3 py-2">{r.reward_points}</td>
              <td className="px-3 py-2">{r.status}</td>
              <td className="px-3 py-2 whitespace-nowrap">{r.rewarded_at || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
