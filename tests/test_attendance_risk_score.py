"""tests/test_attendance_risk_score.py
=======================================
Smart Attendance — risk-score unit tests. The weighted, rule-based score is
the auditable heart of the at-risk flow, so it is exercised against known
input combinations for ALL FOUR signals (no DB, no network).
"""
from __future__ import annotations

import attendance_tools as att


# ── exact weight contract ────────────────────────────────────────────────────
def test_perfect_record_is_zero_risk():
    assert att.compute_risk_score(1.0, 1.0, 0.0, 0.0) == 0


def test_worst_record_is_max_risk():
    assert att.compute_risk_score(0.0, 0.0, 1.0, 1.0) == 100


def test_on_time_5_weight_is_40_percent():
    # only the 5-session on-time signal is bad
    assert att.compute_risk_score(0.0, 1.0, 0.0, 0.0) == 40


def test_on_time_15_weight_is_30_percent():
    assert att.compute_risk_score(1.0, 0.0, 0.0, 0.0) == 30


def test_miss_proximity_weight_is_20_percent():
    assert att.compute_risk_score(1.0, 1.0, 1.0, 0.0) == 20


def test_skipped_confirmation_weight_is_10_percent():
    assert att.compute_risk_score(1.0, 1.0, 0.0, 1.0) == 10


def test_combined_signals_sum_to_expected():
    # 0.4*(1-0.5) + 0.3*(1-0.5) + 0.2*0.5 + 0.1*0.5 = 0.2+0.15+0.1+0.05 = 0.5
    assert att.compute_risk_score(0.5, 0.5, 0.5, 0.5) == 50


def test_inputs_are_clamped_to_unit_interval():
    # values outside [0,1] must not blow past the 0..100 contract
    assert att.compute_risk_score(2.0, -1.0, 5.0, -3.0) in range(0, 101)
    # negative on-time clamps to 0 ⇒ full weight; over-1 proximity clamps to 1
    assert att.compute_risk_score(-1.0, -1.0, 2.0, 2.0) == 100


# ── signal derivation from raw history ───────────────────────────────────────
def test_compute_signals_on_time_rate():
    statuses = [att.ST_PRESENT_FULL, att.ST_LATE, att.ST_ABSENT,
                att.ST_PRESENT_PARTIAL, att.ST_PRESENT_FULL]
    sig = att.compute_signals(statuses, statuses, miss_threshold=3,
                              recent_absences=1, confirmations_offered=4,
                              confirmations_skipped=1)
    # present_full + present_partial + present_full = 3 of 5 are "on time"
    assert sig["on_time_rate_5"] == 3 / 5
    assert sig["miss_threshold_proximity"] == 1 / 3
    assert sig["skipped_confirmation_rate"] == 1 / 4


def test_compute_signals_no_history_is_safe():
    sig = att.compute_signals([], [], miss_threshold=3, recent_absences=0,
                              confirmations_offered=0, confirmations_skipped=0)
    assert sig["on_time_rate_5"] == 1.0
    assert sig["on_time_rate_15"] == 1.0
    assert sig["miss_threshold_proximity"] == 0.0
    assert sig["skipped_confirmation_rate"] == 0.0
    # ⇒ a brand-new student is NOT flagged at risk
    assert att.compute_risk_score(**{
        "on_time_rate_5": sig["on_time_rate_5"],
        "on_time_rate_15": sig["on_time_rate_15"],
        "miss_threshold_proximity": sig["miss_threshold_proximity"],
        "skipped_confirmation_rate": sig["skipped_confirmation_rate"],
    }) == 0


def test_miss_proximity_clamps_when_absences_exceed_threshold():
    sig = att.compute_signals([], [], miss_threshold=2, recent_absences=9,
                              confirmations_offered=0, confirmations_skipped=0)
    assert sig["miss_threshold_proximity"] == 1.0


# ── action bands ─────────────────────────────────────────────────────────────
def test_risk_band_high_at_threshold():
    assert att.risk_band(70, 70) == "high"
    assert att.risk_band(85, 70) == "high"


def test_risk_band_monitored_window():
    assert att.risk_band(40, 70) == "monitored"
    assert att.risk_band(69, 70) == "monitored"


def test_risk_band_standard_below_40():
    assert att.risk_band(39, 70) == "standard"
    assert att.risk_band(0, 70) == "standard"


def test_risk_band_threshold_is_tunable():
    # a stricter teacher lowers the escalation threshold
    assert att.risk_band(55, 50) == "high"
    assert att.risk_band(55, 70) == "monitored"
