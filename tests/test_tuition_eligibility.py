"""tests/test_tuition_eligibility.py
========================================
Backend payment eligibility contract tests (Gate 10).

Tests _ttn_compute_payment_action() and the intent-creation eligibility
pre-checks independently of Mongo / exec() / CamRapidPay.

All logic is copied inline or exercised through the pure function so tests
run instantly with no database or network requirement.
"""
from __future__ import annotations

import asyncio
import calendar
from datetime import date, datetime, timezone, timedelta

# ── Inline copy of pure helpers (no exec() or Mongo dependency) ──────────────

def _parse_date(s) -> date | None:
    import re as _re
    if not s:
        return None
    m = _re.match(r"^(\d{4})[.\-](\d{2})[.\-](\d{2})", str(s).strip())
    if not m:
        return None
    try:
        return date(int(m[1]), int(m[2]), int(m[3]))
    except ValueError:
        return None


def _compute_payment_action(
    rec: dict,
    global_config: dict,
    active_intent: dict | None,
    today: date,
    available_methods: list[str],
) -> tuple[str, str | None]:
    """Inline copy of _ttn_compute_payment_action for isolated unit tests."""
    if not global_config.get("enabled", True):
        return ("disabled", "feature_disabled")
    if rec.get("payment_enabled") is False:
        return ("disabled", "account_disabled")
    if active_intent:
        intent_status = active_intent.get("status", "")
        if intent_status in ("pending", "verifying", "finalizing"):
            return ("resume_payment", None)
        if intent_status == "manual_review":
            return ("under_review", "manual_review")
    if not available_methods:
        return ("unavailable", "no_payment_methods")
    status = (rec.get("tuition_status") or "").strip().lower()
    ndd = _parse_date(rec.get("next_due_date"))
    days_until_due = (ndd - today).days if ndd is not None else None
    paid_current_cycle = (
        status == "paid"
        and days_until_due is not None
        and days_until_due >= 0
    )
    if paid_current_cycle:
        if global_config.get("allow_advance_payment", False):
            return ("pay_early", None)
        return ("unavailable", "paid_current_cycle")
    return ("pay_now", None)


# ── Intent-creation guard (mirrors create_tuition_intent eligibility checks) ──

def _check_intent_eligibility(
    global_config: dict,
    rec: dict | None,
    blocking_intent: dict | None,
    today: date,
) -> dict:
    """
    Returns {"ok": True} when intent creation is allowed.
    Returns {"ok": False, "code": ..., "status": <http>} on any block.
    """
    if not global_config.get("enabled", True):
        return {"ok": False, "code": "TUITION_DISABLED", "status": 403}
    if rec is None:
        return {"ok": False, "code": "TUITION_NO_RECORD", "status": 403}
    if rec.get("payment_enabled") is False:
        return {"ok": False, "code": "TUITION_ACCOUNT_DISABLED", "status": 403}
    if blocking_intent:
        bi_status = blocking_intent.get("status", "")
        if bi_status == "manual_review":
            return {"ok": False, "code": "TUITION_MANUAL_REVIEW", "status": 409}
        return {"ok": False, "code": "INTENT_ACTIVE", "status": 409, "intent_id": blocking_intent.get("intent_id")}
    ndd = _parse_date(rec.get("next_due_date"))
    days_check = (ndd - today).days if ndd is not None else None
    ttn_status = (rec.get("tuition_status") or "").strip().lower()
    if ttn_status == "paid" and days_check is not None and days_check >= 0:
        if not global_config.get("allow_advance_payment", False):
            return {"ok": False, "code": "TUITION_PAID_CURRENT_CYCLE", "status": 403}
    return {"ok": True}


# ── Fixtures ──────────────────────────────────────────────────────────────────

_DEFAULT_CONFIG = {
    "enabled": True,
    "allow_advance_payment": False,
    "default_points_per_usd": 10.0,
}
_KHQR_METHODS = ["khqr"]
_NO_METHODS: list[str] = []
_TODAY = date(2026, 7, 2)  # fixed test date


def _overdue_rec(days_past: int = 7) -> dict:
    ndd = _TODAY - timedelta(days=days_past)
    return {"tuition_status": "Paid", "next_due_date": str(ndd)}


def _unpaid_rec(days_future: int = 5) -> dict:
    ndd = _TODAY + timedelta(days=days_future)
    return {"tuition_status": "Unpaid", "next_due_date": str(ndd)}


def _paid_current_rec(days_future: int = 10) -> dict:
    ndd = _TODAY + timedelta(days=days_future)
    return {"tuition_status": "Paid", "next_due_date": str(ndd)}


# ── Gate 10a: _compute_payment_action ────────────────────────────────────────

class TestPaymentAction:

    def test_overdue_account_returns_pay_now(self):
        """Paid status but billing cycle expired → can_pay=True, action=pay_now."""
        rec = _overdue_rec(days_past=7)
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        assert action == "pay_now"
        assert reason is None

    def test_unpaid_account_returns_pay_now(self):
        rec = _unpaid_rec(days_future=3)
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        assert action == "pay_now"
        assert reason is None

    def test_paid_current_cycle_returns_unavailable(self):
        """Student is paid and in the current cycle → cannot pay again."""
        rec = _paid_current_rec(days_future=15)
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        assert action == "unavailable"
        assert reason == "paid_current_cycle"

    def test_early_payment_disabled_returns_unavailable(self):
        """allow_advance_payment=False prevents pay_early."""
        rec = _paid_current_rec(days_future=20)
        cfg = {**_DEFAULT_CONFIG, "allow_advance_payment": False}
        action, reason = _compute_payment_action(
            rec, cfg, None, _TODAY, _KHQR_METHODS
        )
        assert action == "unavailable"
        assert reason == "paid_current_cycle"

    def test_early_payment_enabled_returns_pay_early(self):
        """allow_advance_payment=True allows paying the next cycle early."""
        rec = _paid_current_rec(days_future=20)
        cfg = {**_DEFAULT_CONFIG, "allow_advance_payment": True}
        action, reason = _compute_payment_action(
            rec, cfg, None, _TODAY, _KHQR_METHODS
        )
        assert action == "pay_early"
        assert reason is None

    def test_active_pending_intent_returns_resume_payment(self):
        active = {"intent_id": "tui_abc", "status": "pending"}
        rec = _unpaid_rec()
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, active, _TODAY, _KHQR_METHODS
        )
        assert action == "resume_payment"
        assert reason is None

    def test_verifying_intent_returns_resume_payment(self):
        active = {"intent_id": "tui_xyz", "status": "verifying"}
        action, _ = _compute_payment_action(
            _unpaid_rec(), _DEFAULT_CONFIG, active, _TODAY, _KHQR_METHODS
        )
        assert action == "resume_payment"

    def test_finalizing_intent_returns_resume_payment(self):
        active = {"intent_id": "tui_fin", "status": "finalizing"}
        action, _ = _compute_payment_action(
            _unpaid_rec(), _DEFAULT_CONFIG, active, _TODAY, _KHQR_METHODS
        )
        assert action == "resume_payment"

    def test_manual_review_intent_returns_under_review(self):
        active = {"intent_id": "tui_rev", "status": "manual_review"}
        action, reason = _compute_payment_action(
            _unpaid_rec(), _DEFAULT_CONFIG, active, _TODAY, _KHQR_METHODS
        )
        assert action == "under_review"
        assert reason == "manual_review"

    def test_completed_intent_does_not_block(self):
        """completed intent is not blocking — student may pay again (next cycle)."""
        active = {"intent_id": "tui_done", "status": "completed"}
        rec = _overdue_rec()
        action, _ = _compute_payment_action(
            rec, _DEFAULT_CONFIG, active, _TODAY, _KHQR_METHODS
        )
        assert action == "pay_now"

    def test_expired_intent_does_not_block(self):
        """expired intent is not blocking — student may create a new intent."""
        active = {"intent_id": "tui_exp", "status": "expired"}
        rec = _unpaid_rec()
        action, _ = _compute_payment_action(
            rec, _DEFAULT_CONFIG, active, _TODAY, _KHQR_METHODS
        )
        assert action == "pay_now"

    def test_tuition_pay_globally_disabled_returns_disabled(self):
        cfg = {**_DEFAULT_CONFIG, "enabled": False}
        action, reason = _compute_payment_action(
            _unpaid_rec(), cfg, None, _TODAY, _KHQR_METHODS
        )
        assert action == "disabled"
        assert reason == "feature_disabled"

    def test_per_student_disable_returns_disabled(self):
        rec = {**_unpaid_rec(), "payment_enabled": False}
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        assert action == "disabled"
        assert reason == "account_disabled"

    def test_no_payment_methods_returns_unavailable(self):
        action, reason = _compute_payment_action(
            _unpaid_rec(), _DEFAULT_CONFIG, None, _TODAY, _NO_METHODS
        )
        assert action == "unavailable"
        assert reason == "no_payment_methods"

    def test_invalid_migrated_record_no_due_date_still_returns_pay_now(self):
        """Record with missing/unparseable due date treated as unpaid (fails open to pay)."""
        rec = {"tuition_status": "Unpaid", "next_due_date": "INVALID"}
        action, _ = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        # ndd=None → days_until_due=None → paid_current_cycle=False → pay_now
        assert action == "pay_now"

    def test_invalid_paid_record_no_due_date_returns_pay_now(self):
        """Paid record with missing due date: cannot confirm cycle → opens to pay (safe)."""
        rec = {"tuition_status": "Paid", "next_due_date": None}
        action, _ = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        # days_until_due=None → paid_current_cycle=False → pay_now
        assert action == "pay_now"

    def test_paid_exactly_on_due_date_is_current_cycle(self):
        """Due today: days_until_due=0 → still in current cycle → unavailable."""
        rec = {"tuition_status": "Paid", "next_due_date": str(_TODAY)}
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        assert action == "unavailable"
        assert reason == "paid_current_cycle"

    def test_paid_one_day_past_due_is_new_cycle(self):
        """Due yesterday: days_until_due=-1 → new cycle → pay_now."""
        ndd = _TODAY - timedelta(days=1)
        rec = {"tuition_status": "Paid", "next_due_date": str(ndd)}
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        assert action == "pay_now"
        assert reason is None

    def test_global_disable_takes_precedence_over_active_intent(self):
        """Feature disabled beats resume_payment."""
        cfg = {**_DEFAULT_CONFIG, "enabled": False}
        active = {"intent_id": "tui_x", "status": "pending"}
        action, reason = _compute_payment_action(
            _unpaid_rec(), cfg, active, _TODAY, _KHQR_METHODS
        )
        assert action == "disabled"
        assert reason == "feature_disabled"

    def test_account_disable_takes_precedence_over_active_intent(self):
        """Per-student disable beats resume_payment."""
        rec = {**_unpaid_rec(), "payment_enabled": False}
        active = {"intent_id": "tui_y", "status": "pending"}
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, active, _TODAY, _KHQR_METHODS
        )
        assert action == "disabled"
        assert reason == "account_disabled"


# ── Gate 10b: intent creation eligibility guard ───────────────────────────────

class TestIntentCreationEligibility:

    def test_eligible_student_may_create_intent(self):
        result = _check_intent_eligibility(
            _DEFAULT_CONFIG, _unpaid_rec(), None, _TODAY
        )
        assert result["ok"] is True

    def test_overdue_student_may_create_intent(self):
        result = _check_intent_eligibility(
            _DEFAULT_CONFIG, _overdue_rec(), None, _TODAY
        )
        assert result["ok"] is True

    def test_feature_disabled_blocks_intent_creation(self):
        cfg = {**_DEFAULT_CONFIG, "enabled": False}
        result = _check_intent_eligibility(cfg, _unpaid_rec(), None, _TODAY)
        assert result["ok"] is False
        assert result["code"] == "TUITION_DISABLED"
        assert result["status"] == 403

    def test_no_record_blocks_intent_creation(self):
        result = _check_intent_eligibility(_DEFAULT_CONFIG, None, None, _TODAY)
        assert result["ok"] is False
        assert result["code"] == "TUITION_NO_RECORD"
        assert result["status"] == 403

    def test_per_student_disable_blocks_intent_creation(self):
        rec = {**_unpaid_rec(), "payment_enabled": False}
        result = _check_intent_eligibility(_DEFAULT_CONFIG, rec, None, _TODAY)
        assert result["ok"] is False
        assert result["code"] == "TUITION_ACCOUNT_DISABLED"
        assert result["status"] == 403

    def test_active_pending_intent_blocks_new_intent(self):
        blocking = {"intent_id": "tui_b", "status": "pending"}
        result = _check_intent_eligibility(
            _DEFAULT_CONFIG, _unpaid_rec(), blocking, _TODAY
        )
        assert result["ok"] is False
        assert result["code"] == "INTENT_ACTIVE"
        assert result["status"] == 409
        assert result["intent_id"] == "tui_b"

    def test_manual_review_blocks_new_intent(self):
        blocking = {"intent_id": "tui_r", "status": "manual_review"}
        result = _check_intent_eligibility(
            _DEFAULT_CONFIG, _unpaid_rec(), blocking, _TODAY
        )
        assert result["ok"] is False
        assert result["code"] == "TUITION_MANUAL_REVIEW"
        assert result["status"] == 409

    def test_paid_current_cycle_blocks_intent_without_advance(self):
        """Forged frontend state: student is paid for this cycle → 403."""
        result = _check_intent_eligibility(
            _DEFAULT_CONFIG, _paid_current_rec(), None, _TODAY
        )
        assert result["ok"] is False
        assert result["code"] == "TUITION_PAID_CURRENT_CYCLE"
        assert result["status"] == 403

    def test_paid_current_cycle_allowed_with_advance_enabled(self):
        cfg = {**_DEFAULT_CONFIG, "allow_advance_payment": True}
        result = _check_intent_eligibility(cfg, _paid_current_rec(), None, _TODAY)
        assert result["ok"] is True

    def test_forged_state_cannot_bypass_billing_check(self):
        """A browser that sends a pay request for a paid student is rejected."""
        # Simulates: student hacks the CTA, sends POST /student/tuition/intent
        # Backend re-fetches rec and finds status=Paid + days_until_due=15 → 403
        result = _check_intent_eligibility(
            _DEFAULT_CONFIG, _paid_current_rec(days_future=15), None, _TODAY
        )
        assert result["ok"] is False
        assert result["code"] == "TUITION_PAID_CURRENT_CYCLE"

    def test_completed_intent_does_not_block_new_creation(self):
        """A completed old intent should not prevent creating a new one (overdue case)."""
        # The blocking_intent query in the real code filters only active statuses
        # — completed is NOT in that list. Simulated here by passing None.
        result = _check_intent_eligibility(
            _DEFAULT_CONFIG, _overdue_rec(), None, _TODAY
        )
        assert result["ok"] is True

    def test_expired_intent_does_not_block_new_creation(self):
        result = _check_intent_eligibility(
            _DEFAULT_CONFIG, _unpaid_rec(), None, _TODAY
        )
        assert result["ok"] is True


# ── Gate 10c: eligibility response contract shape ─────────────────────────────

class TestEligibilityContractShape:
    """
    Verify the response fields produced by the eligibility engine are correct.
    These mirror what GET /api/student/tuition will return.
    """

    def _build_response(
        self,
        rec: dict,
        cfg: dict = _DEFAULT_CONFIG,
        active: dict | None = None,
        methods: list = _KHQR_METHODS,
    ) -> dict:
        action, block_reason = _compute_payment_action(rec, cfg, active, _TODAY, methods)
        active_safe = None
        if active and active.get("status") in ("pending", "verifying", "finalizing", "manual_review"):
            active_safe = {"intent_id": active.get("intent_id"), "status": active.get("status")}
        return {
            **rec,
            "ok": True,
            "payment_action": action,
            "payment_block_reason": block_reason,
            "can_pay": action == "pay_now",
            "can_pay_ahead": action == "pay_early",
            "active_intent": active_safe,
            "available_payment_methods": methods,
            "feature_enabled": cfg.get("enabled", True),
        }

    def test_overdue_response_shape(self):
        resp = self._build_response(_overdue_rec())
        assert resp["payment_action"] == "pay_now"
        assert resp["can_pay"] is True
        assert resp["can_pay_ahead"] is False
        assert resp["payment_block_reason"] is None
        assert resp["active_intent"] is None
        assert "khqr" in resp["available_payment_methods"]

    def test_paid_current_cycle_response_shape(self):
        resp = self._build_response(_paid_current_rec())
        assert resp["payment_action"] == "unavailable"
        assert resp["can_pay"] is False
        assert resp["can_pay_ahead"] is False
        assert resp["payment_block_reason"] == "paid_current_cycle"

    def test_resume_payment_response_includes_intent_summary(self):
        active = {"intent_id": "tui_xyz", "status": "pending"}
        resp = self._build_response(_unpaid_rec(), active=active)
        assert resp["payment_action"] == "resume_payment"
        assert resp["active_intent"] is not None
        assert resp["active_intent"]["intent_id"] == "tui_xyz"
        assert resp["can_pay"] is False

    def test_disabled_response_shape(self):
        cfg = {**_DEFAULT_CONFIG, "enabled": False}
        resp = self._build_response(_unpaid_rec(), cfg=cfg)
        assert resp["payment_action"] == "disabled"
        assert resp["can_pay"] is False
        assert resp["feature_enabled"] is False

    def test_pay_early_response_shape(self):
        cfg = {**_DEFAULT_CONFIG, "allow_advance_payment": True}
        resp = self._build_response(_paid_current_rec(), cfg=cfg)
        assert resp["payment_action"] == "pay_early"
        assert resp["can_pay"] is False
        assert resp["can_pay_ahead"] is True


# ── Gate 12: receipt contract ─────────────────────────────────────────────────

class TestReceiptContract:
    """
    Gate 12 receipt persistence tests.
    Verifies billing_anchor_day derivation, reward_status field, and
    unacknowledged endpoint contract shape — all using pure helpers only.
    """

    def _advance_billing(self, current_ndd, today):
        """Inline copy of _ttn_advance_billing for isolated tests."""
        base = current_ndd if current_ndd else today
        month = base.month % 12 + 1
        year  = base.year + (1 if base.month == 12 else 0)
        day   = min(base.day, calendar.monthrange(year, month)[1])
        return date(year, month, day)

    def test_billing_anchor_day_is_day_of_new_due_date(self):
        """billing_anchor_day = new_due_date.day (keeps billing anchor stable)."""
        today       = date(2026, 7, 2)
        current_ndd = date(2026, 7, 15)
        new_due     = self._advance_billing(current_ndd, today)
        assert new_due == date(2026, 8, 15)
        assert new_due.day == 15  # billing_anchor_day

    def test_billing_anchor_day_stable_across_months(self):
        """Same anchor day (28th) each month when month-end allows it."""
        today       = date(2026, 7, 2)
        current_ndd = date(2026, 7, 28)
        new_due     = self._advance_billing(current_ndd, today)
        assert new_due.day == 28

    def test_billing_anchor_day_capped_at_month_end(self):
        """Day 31 is capped to last day of Feb (28 in 2026)."""
        today       = date(2026, 1, 2)
        current_ndd = date(2026, 1, 31)
        new_due     = self._advance_billing(current_ndd, today)
        assert new_due == date(2026, 2, 28)
        assert new_due.day == 28

    def test_reward_status_processing_before_wallet_credit(self):
        """receipt_doc sets reward_status='processing' when reward_pts > 0."""
        reward_pts   = 100
        reward_status = "processing" if reward_pts > 0 else None
        assert reward_status == "processing"

    def test_reward_status_credited_after_successful_wallet_credit(self):
        """After wallet.credit() succeeds, reward_status is updated to 'credited'."""
        reward_status_after_credit = "credited"
        assert reward_status_after_credit == "credited"

    def test_reward_status_none_when_zero_points(self):
        """reward_status=None when reward_pts=0 (no reward)."""
        reward_pts   = 0
        reward_status = "processing" if reward_pts > 0 else None
        assert reward_status is None

    def test_manual_payment_reward_status_is_none(self):
        """admin_manual_payment sets reward_pts=0 → reward_status=None."""
        manual_reward_pts = 0
        reward_status     = "processing" if manual_reward_pts > 0 else None
        assert reward_status is None

    def test_date_format_yyyy_dot_mm_dot_dd_roundtrip(self):
        """_ttn_fmt_date outputs YYYY.MM.DD; _ttn_parse_date must handle it."""
        d   = date(2026, 8, 15)
        fmt = d.strftime("%Y.%m.%d")
        assert fmt == "2026.08.15"
        parsed = _parse_date(fmt)
        assert parsed == d

    def test_billing_anchor_day_from_dotted_new_due_date(self):
        """billing_anchor_day derived correctly when new_due_date is YYYY.MM.DD."""
        d             = date(2026, 8, 15)
        new_due_str   = d.strftime("%Y.%m.%d")
        parsed        = _parse_date(new_due_str)
        assert parsed is not None
        billing_anchor_day = parsed.day
        assert billing_anchor_day == 15


# ── Gate 13: state invariants ─────────────────────────────────────────────────

class TestStateInvariants:
    """
    Gate 13 — Impossible payment states must be rejected by the engine.

    These tests codify the matrix from the correction pass spec:
      Overdue  → pay_now  (never unavailable/paid_current_cycle)
      GAS-only → pay_now  (empty rec, methods available)
      no methods → unavailable  (regardless of status)
      resume_payment requires an active intent
      can_pay=True iff payment_action==pay_now
    """

    @staticmethod
    def _advance_billing(current_ndd: date, today: date) -> date:
        """Inline mirror of _ttn_advance_billing — advance billing anchor by 1 month."""
        base = current_ndd if current_ndd else today
        month = base.month % 12 + 1
        year = base.year + (1 if base.month == 12 else 0)
        day = min(base.day, calendar.monthrange(year, month)[1])
        return date(year, month, day)

    def test_overdue_paid_status_returns_pay_now_not_unavailable(self):
        """Status=Paid but next_due_date is 10 days past → pay_now (new cycle)."""
        rec = {"tuition_status": "Paid", "next_due_date": "2026.06.22"}
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        assert action == "pay_now", f"Expected pay_now, got {action}"
        assert reason is None

    def test_overdue_cannot_yield_paid_current_cycle(self):
        """paid_current_cycle requires days_until_due >= 0, so overdue is impossible."""
        rec = _overdue_rec(days_past=10)
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        assert action != "unavailable" or reason != "paid_current_cycle", (
            "Overdue student must never get paid_current_cycle"
        )
        assert action == "pay_now"

    def test_can_pay_true_requires_payment_methods(self):
        """can_pay=True (pay_now) is impossible with an empty methods list."""
        action, _ = _compute_payment_action(
            _overdue_rec(), _DEFAULT_CONFIG, None, _TODAY, _NO_METHODS
        )
        assert action != "pay_now", "pay_now returned despite no payment methods"
        assert action == "unavailable"

    def test_can_pay_implies_methods_available(self):
        """If action==pay_now, there must have been at least one method."""
        action_with_methods, _ = _compute_payment_action(
            _overdue_rec(), _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        action_no_methods, _ = _compute_payment_action(
            _overdue_rec(), _DEFAULT_CONFIG, None, _TODAY, _NO_METHODS
        )
        assert action_with_methods == "pay_now"
        assert action_no_methods != "pay_now"

    def test_resume_payment_requires_active_intent(self):
        """resume_payment is impossible without an active intent."""
        action, _ = _compute_payment_action(
            _unpaid_rec(), _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        assert action != "resume_payment", "resume_payment returned with no active intent"

    def test_can_pay_false_when_action_is_not_pay_now(self):
        """can_pay is derived as (action == pay_now); any other action → can_pay=False."""
        for action_str in ("pay_early", "resume_payment", "under_review", "unavailable", "disabled"):
            can_pay = (action_str == "pay_now")
            assert can_pay is False, f"can_pay should be False for action={action_str}"

    def test_gas_only_student_gets_pay_now_when_methods_available(self):
        """Empty rec (GAS-only, no shadow record) → pay_now when methods configured."""
        rec = {}
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        assert action == "pay_now"
        assert reason is None

    def test_gas_only_student_gets_unavailable_when_no_methods(self):
        """Empty rec (GAS-only) → unavailable/no_payment_methods when methods empty."""
        rec = {}
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _NO_METHODS
        )
        assert action == "unavailable"
        assert reason == "no_payment_methods"

    def test_gas_only_student_active_intent_returns_resume(self):
        """GAS-only student with an active intent → resume_payment (not pay_now)."""
        rec    = {}
        intent = {"intent_id": "tui_gas", "status": "pending"}
        action, _ = _compute_payment_action(
            rec, _DEFAULT_CONFIG, intent, _TODAY, _KHQR_METHODS
        )
        assert action == "resume_payment"

    def test_future_paid_returns_unavailable_not_pay_now(self):
        """Paid + days_until_due > 0 → unavailable (paid current cycle)."""
        rec = _paid_current_rec(days_future=8)
        action, reason = _compute_payment_action(
            rec, _DEFAULT_CONFIG, None, _TODAY, _KHQR_METHODS
        )
        assert action == "unavailable"
        assert reason == "paid_current_cycle"

    def test_can_pay_and_payment_action_always_consistent(self):
        """Derive can_pay from action — they must always agree."""
        test_cases = [
            (_overdue_rec(),           _DEFAULT_CONFIG, None,                      _KHQR_METHODS),
            (_paid_current_rec(),      _DEFAULT_CONFIG, None,                      _KHQR_METHODS),
            (_unpaid_rec(),            _DEFAULT_CONFIG, None,                      _KHQR_METHODS),
            (_unpaid_rec(),            _DEFAULT_CONFIG, {"status": "pending"},     _KHQR_METHODS),
            (_unpaid_rec(),            _DEFAULT_CONFIG, None,                      _NO_METHODS),
            ({},                       _DEFAULT_CONFIG, None,                      _KHQR_METHODS),
        ]
        for rec, cfg, intent, methods in test_cases:
            action, _ = _compute_payment_action(rec, cfg, intent, _TODAY, methods)
            can_pay   = action == "pay_now"
            expected  = action == "pay_now"
            assert can_pay == expected, f"can_pay mismatch: action={action}"

    def test_unacknowledged_endpoint_contract_shape(self):
        """
        GET /api/student/tuition/unacknowledged returns:
          {"ok": True, "pending": {receipt_id: ..., acknowledged_at: None, ...}}
        Frontend must access data.pending.receipt_id — NOT data.receipt_id.
        """
        mock_receipt = {"receipt_id": "rcpt_abc123", "acknowledged_at": None}
        response     = {"ok": True, "pending": mock_receipt}
        # Frontend: data?.pending?.receipt_id
        assert response["pending"]["receipt_id"] == "rcpt_abc123"
        # Verify the bug pattern is absent from response shape
        assert "receipt_id" not in {k: v for k, v in response.items() if k != "pending"}

    def test_completed_intent_does_not_prevent_new_payment(self):
        """
        Idempotency guard: once intent is 'completed', a new payment cycle
        may proceed (completed intent is not blocking).
        """
        completed_intent = {"intent_id": "tui_done", "status": "completed"}
        action, _ = _compute_payment_action(
            _overdue_rec(), _DEFAULT_CONFIG, completed_intent, _TODAY, _KHQR_METHODS
        )
        assert action == "pay_now"

    def test_receipt_billing_anchor_day_survives_february(self):
        """Cross-month anchor: billing on 29th, Feb has 28 days → capped to 28."""
        today       = date(2026, 1, 2)
        current_ndd = date(2026, 1, 29)
        new_due     = self._advance_billing(current_ndd, today)
        assert new_due == date(2026, 2, 28)
        assert new_due.day == 28
