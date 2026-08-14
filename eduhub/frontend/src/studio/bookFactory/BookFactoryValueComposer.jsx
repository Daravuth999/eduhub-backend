/**
 * BookFactoryValueComposer.jsx — tier + price (author-owned) PLUS the two
 * separate advisory metrics (§HIGH 13):
 *   - Student Value  (Low / Moderate / High / Rich)
 *   - Production Cost (the actual Phase 1 pipeline: 1 blueprint + N chapters)
 * Both are advisory; NEITHER blocks Generate. Book Factory never infers or
 * overrides tier/price — selecting a tier only OFFERS a price hint.
 */
import { TIERS, studentValue, productionCost } from "./bookFactorySchema";

const field = "w-full rounded-lg bg-walnut/40 border border-gold/20 px-3 py-2 text-[13px] text-parchment focus:border-gold outline-none";
const lbl = "block text-[11px] uppercase tracking-wider text-faded mb-1";

export const BookFactoryValueComposer = ({ config, onChange }) => {
  const set = (k, v) => onChange({ ...config, [k]: v });
  const value = studentValue(config);
  const cost = productionCost(config);

  return (
    <div className="rounded-xl border border-gold/15 bg-walnut/20 p-3 space-y-3" data-testid="book-factory-value-composer">
      <p className="text-[11px] uppercase tracking-wider text-gold/80">Tier &amp; price (author-owned)</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className={lbl}>Tier</label>
          <select className={field} value={config.tier} data-testid="bf-tier" onChange={(e) => set("tier", e.target.value)}>
            {TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className={lbl}>Price (points)</label>
          <input type="number" min={0} className={field} value={config.price} data-testid="bf-price"
                 onChange={(e) => set("price", parseInt(e.target.value || "0", 10))} />
        </div>
      </div>
      <button type="button" data-testid="bf-apply-price-hint" className="text-[11px] text-gold/90 underline underline-offset-2"
              onClick={() => { const h = TIERS.find((t) => t.value === config.tier)?.priceHint; if (typeof h === "number") set("price", h); }}>
        Use suggested price for this tier
      </button>
      <p className="text-[10.5px] text-faded">Suggestions only — your tier and price are saved exactly as set.</p>

      <div className="grid sm:grid-cols-2 gap-3 pt-1">
        <div className="rounded-lg border border-white/10 bg-black/20 p-2.5" data-testid="bf-student-value">
          <p className="text-[10px] uppercase tracking-wider text-faded">Student value</p>
          <p className="text-[15px] font-bold text-parchment" data-testid="bf-student-value-level">{value.level}</p>
          <p className="text-[10.5px] text-faded">Advisory — never blocks Generate.</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/20 p-2.5" data-testid="bf-production-cost">
          <p className="text-[10px] uppercase tracking-wider text-faded">Production cost (Gemini calls)</p>
          <p className="text-[15px] font-bold text-parchment" data-testid="bf-production-cost-normal">{cost.normalCalls}</p>
          <p className="text-[10.5px] text-faded">
            1 blueprint + {cost.chapters} chapters. No MCQ-repair calls in Phase 1.
            Exceptional bounded invalid-JSON retries (worst case {cost.exceptionalMaxCalls}) not included.
          </p>
        </div>
      </div>
    </div>
  );
};

export default BookFactoryValueComposer;
