"""tests/test_attendance_streaks.py
=====================================
Smart Attendance — streak, reliability-tier and tier-multiplier unit tests.
All pure functions; non-punitive tier rules verified (lower tier only lowers
the multiplier, never restricts).
"""
from __future__ import annotations

import attendance_tools as att

TIERS = att.default_settings()["reward_tiers"]


# ── streaks ──────────────────────────────────────────────────────────────────
def _row(date, status):
    return (date, status)


def test_streak_counts_trailing_present_run():
    rows = [
        _row("2026-06-01", att.ST_PRESENT_FULL),
        _row("2026-06-02", att.ST_LATE),
        _row("2026-06-03", att.ST_ABSENT),
        _row("2026-06-04", att.ST_PRESENT_FULL),
        _row("2026-06-05", att.ST_PRESENT_PARTIAL),
    ]
    current, longest = att.compute_streak(rows)
    assert current == 2          # 06-04, 06-05
    assert longest == 2          # best run is also 2


def test_streak_absent_breaks_run():
    rows = [
        _row("2026-06-01", att.ST_PRESENT_FULL),
        _row("2026-06-02", att.ST_PRESENT_FULL),
        _row("2026-06-03", att.ST_PRESENT_FULL),
        _row("2026-06-04", att.ST_ABSENT),
    ]
    current, longest = att.compute_streak(rows)
    assert current == 0
    assert longest == 3


def test_streak_handles_unordered_input():
    rows = [
        _row("2026-06-03", att.ST_PRESENT_FULL),
        _row("2026-06-01", att.ST_PRESENT_FULL),
        _row("2026-06-02", att.ST_PRESENT_FULL),
    ]
    current, longest = att.compute_streak(rows)
    assert current == 3
    assert longest == 3


def test_streak_empty():
    assert att.compute_streak([]) == (0, 0)


def test_late_counts_as_present_for_streak():
    rows = [_row("2026-06-01", att.ST_LATE), _row("2026-06-02", att.ST_LATE)]
    assert att.compute_streak(rows) == (2, 2)


# ── tiers ────────────────────────────────────────────────────────────────────
def test_tier_bronze_floor():
    assert att.compute_tier(0.0, 0.0, TIERS) == att.TIER_BRONZE


def test_tier_silver():
    assert att.compute_tier(0.72, 0.65, TIERS) == att.TIER_SILVER


def test_tier_gold():
    assert att.compute_tier(0.9, 0.82, TIERS) == att.TIER_GOLD


def test_tier_diamond():
    assert att.compute_tier(0.98, 0.95, TIERS) == att.TIER_DIAMOND


def test_tier_needs_both_thresholds():
    # high attendance but low on-time cannot reach gold
    assert att.compute_tier(0.99, 0.5, TIERS) == att.TIER_BRONZE


def test_tier_clamps_out_of_range_inputs():
    assert att.compute_tier(5.0, 5.0, TIERS) == att.TIER_DIAMOND


# ── multipliers (falling tier reduces multiplier; never restricts) ───────────
def test_multiplier_increases_with_tier():
    m_bronze = att.tier_multiplier(att.TIER_BRONZE, TIERS)
    m_silver = att.tier_multiplier(att.TIER_SILVER, TIERS)
    m_gold = att.tier_multiplier(att.TIER_GOLD, TIERS)
    m_diamond = att.tier_multiplier(att.TIER_DIAMOND, TIERS)
    assert m_bronze < m_silver < m_gold < m_diamond
    assert m_bronze == 1.0


def test_multiplier_unknown_tier_defaults_to_one():
    assert att.tier_multiplier("platinum", TIERS) == 1.0
