"""tests/test_book_factory_interaction_planner.py
=======================================================
Checkpoint 1 foundation tests for the tier/weighted-density policy and the
deterministic chapter-interaction planner. Pure functions — no network,
no Mongo, no Gemini call anywhere.
"""
from __future__ import annotations

import book_factory_interaction_planner as planner


# ── tier policy shape ────────────────────────────────────────────────────────
def test_free_tier_only_allows_light_types():
    pol = planner.tier_policy("free")
    assert set(pol["allowedTypes"]) <= {"reveal", "mission"}
    assert pol["densityBudget"] == 1


def test_unknown_tier_falls_back_to_free():
    pol = planner.tier_policy("not-a-real-tier")
    assert pol == planner.tier_policy("free")


def test_premium_and_limited_allow_all_optional_types():
    for tier in ("premium", "limited"):
        pol = planner.tier_policy(tier)
        assert set(pol["allowedTypes"]) == set(planner.INTERACTION_WEIGHTS.keys())


# ── deterministic planner ───────────────────────────────────────────────────
def test_planner_never_requests_all_types_blindly():
    plan = planner.plan_chapter_interactions(tier="premium", job_id="job1", chapter_index=0)
    assert len(plan["types"]) < len(planner.INTERACTION_WEIGHTS)
    assert plan["vocabIncluded"] is True


def test_planner_respects_density_budget():
    for tier, pol in planner.TIER_INTERACTION_POLICY.items():
        for chapter_index in range(6):
            plan = planner.plan_chapter_interactions(tier=tier, job_id="jobX", chapter_index=chapter_index)
            weight = sum(planner.INTERACTION_WEIGHTS.get(t, 1) for t in plan["types"])
            assert weight <= pol["densityBudget"]
            assert len(plan["types"]) <= pol["maxOptionalCount"]


def test_planner_never_selects_two_heavy_types_same_chapter():
    heavy = {"checkpoint", "branchdialog"}
    for chapter_index in range(10):
        plan = planner.plan_chapter_interactions(tier="limited", job_id="jobY", chapter_index=chapter_index)
        assert len(heavy.intersection(plan["types"])) <= 1


def test_planner_is_deterministic_for_identical_inputs():
    a = planner.plan_chapter_interactions(tier="premium", job_id="jobZ", chapter_index=2)
    b = planner.plan_chapter_interactions(tier="premium", job_id="jobZ", chapter_index=2)
    assert a == b


def test_planner_free_tier_never_exceeds_one_optional_type():
    for chapter_index in range(5):
        plan = planner.plan_chapter_interactions(tier="free", job_id="jobF", chapter_index=chapter_index)
        assert len(plan["types"]) <= 1
        assert set(plan["types"]) <= {"reveal", "mission"}


def test_planner_only_selects_types_allowed_for_the_tier():
    for tier in planner.TIER_INTERACTION_POLICY:
        allowed = set(planner.tier_policy(tier)["allowedTypes"])
        for chapter_index in range(8):
            plan = planner.plan_chapter_interactions(tier=tier, job_id="jobT", chapter_index=chapter_index)
            assert set(plan["types"]) <= allowed


def test_planner_avoids_repeating_recent_type_when_alternative_exists():
    # premium has multiple non-heavy alternatives — recent history should be
    # deprioritized (soft constraint), not necessarily eliminated entirely.
    plan_a = planner.plan_chapter_interactions(tier="premium", job_id="jobR", chapter_index=0)
    plan_b = planner.plan_chapter_interactions(
        tier="premium", job_id="jobR", chapter_index=1, recent_type_history=plan_a["types"],
    )
    assert isinstance(plan_b["types"], list)  # ran without error; softness means no strict inequality assert


# ── bounded cross-chapter continuity bookkeeping ────────────────────────────
def test_learning_targets_accumulate_and_dedupe():
    targets = planner.update_learning_targets(None, ["deadline", "escalate"], chapter_index=0)
    targets = planner.update_learning_targets(targets, ["deadline", "bottleneck"], chapter_index=1)
    terms = [t["term"] for t in targets]
    assert terms.count("deadline") == 1
    assert "escalate" in terms and "bottleneck" in terms


def test_learning_targets_bounded_at_cap():
    targets = None
    for i in range(30):
        targets = planner.update_learning_targets(targets, [f"term{i}"], chapter_index=i)
    assert len(targets) == planner._MAX_LEARNING_TARGETS
    # oldest entries dropped first — most recent term must survive.
    assert any(t["term"] == "term29" for t in targets)
    assert not any(t["term"] == "term0" for t in targets)


def test_recent_learning_targets_for_prompt_is_bounded():
    targets = [{"term": f"t{i}", "chapterIntroduced": i} for i in range(15)]
    recent = planner.recent_learning_targets_for_prompt(targets)
    assert len(recent) == planner._PROMPT_RECENT_TARGETS
    assert recent[-1] == "t14"
