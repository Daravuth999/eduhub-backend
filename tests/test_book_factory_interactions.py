"""tests/test_book_factory_interactions.py
================================================
Checkpoint 1 foundation tests for the nine premium interaction block
validators (book_factory_interactions.py). Pure functions — no network, no
Mongo. Covers every §Checkpoint-1-required-test item for schema validation.
"""
from __future__ import annotations

import book_factory_interactions as bfi


# ── 1. vocabgrid ─────────────────────────────────────────────────────────────
def test_vocabgrid_valid_items_survive_with_stable_ids():
    semantic = {"title": "Key words", "items": [
        {"word": "deadline", "definitionEnglish": "a time limit", "ipa": "/ˈdedlaɪn/"},
        {"word": "escalate", "definitionEnglish": "to raise an issue"},
    ]}
    block, warnings = bfi.validate_vocabgrid(semantic, vocab_hi=5)
    assert block is not None
    assert block["type"] == "vocabgrid"
    assert len(block["items"]) == 2
    ids = [it["id"] for it in block["items"]]
    assert len(set(ids)) == 2  # unique, stable, never array index


def test_vocabgrid_drops_invalid_items_keeps_valid():
    semantic = {"items": [
        {"word": "escalate", "definitionEnglish": "raise an issue"},
        {"word": "", "definitionEnglish": "missing word"},
    ]}
    block, warnings = bfi.validate_vocabgrid(semantic)
    assert block is not None
    assert len(block["items"]) == 1
    assert any("vocab_missing_or_invalid_word" in w for w in warnings)


def test_vocabgrid_empty_after_validation_drops_whole_block():
    block, warnings = bfi.validate_vocabgrid({"items": [{"word": ""}]})
    assert block is None
    assert "vocabgrid_empty_after_validation" in warnings


def test_vocabgrid_not_object_rejected():
    block, warnings = bfi.validate_vocabgrid("not a dict")
    assert block is None and warnings == ["vocabgrid_not_object"]


# ── 2. pronunciation ─────────────────────────────────────────────────────────
def test_pronunciation_valid():
    block, warnings = bfi.validate_pronunciation({
        "targetText": "Could you send me the report by Friday?",
        "ipa": "/kʊd juː send miː ðə rɪˈpɔːrt baɪ ˈfraɪdeɪ/",
        "stressWords": ["send", "report", "Friday"],
        "tip": "Link 'could' and 'you'.",
    })
    assert block is not None
    assert block["stressWords"] == ["send", "report", "Friday"]
    assert block["ipa"].startswith("/")


def test_pronunciation_invalid_ipa_omitted_not_fatal():
    block, warnings = bfi.validate_pronunciation({
        "targetText": "Nice to meet you.", "ipa": "nice to meet you",  # plain spelling, not IPA
    })
    assert block is not None
    assert block["ipa"] == ""
    assert any("pronunciation_ipa_rejected" in w for w in warnings)


def test_pronunciation_stress_word_not_in_text_is_dropped_with_warning():
    block, warnings = bfi.validate_pronunciation({
        "targetText": "Nice to meet you.", "stressWords": ["banana"],
    })
    assert block is not None
    assert block["stressWords"] == []
    assert any("stress_word_not_in_text" in w for w in warnings)


def test_pronunciation_missing_target_text_drops_block():
    block, warnings = bfi.validate_pronunciation({"targetText": ""})
    assert block is None


# ── 3. matchpairs ────────────────────────────────────────────────────────────
def test_matchpairs_valid():
    block, warnings = bfi.validate_matchpairs({"pairs": [
        {"prompt": "touch base", "answer": "make contact"},
        {"prompt": "circle back", "answer": "return later"},
    ]})
    assert block is not None
    assert len(block["pairs"]) == 2
    ids = [p["id"] for p in block["pairs"]]
    assert len(set(ids)) == 2


def test_matchpairs_below_minimum_dropped():
    block, warnings = bfi.validate_matchpairs({"pairs": [{"prompt": "a", "answer": "b"}]})
    assert block is None


def test_matchpairs_bounded_at_max():
    pairs = [{"prompt": f"p{i}", "answer": f"a{i}"} for i in range(10)]
    block, warnings = bfi.validate_matchpairs({"pairs": pairs})
    assert block is not None
    assert len(block["pairs"]) == bfi._MAX_MATCHPAIRS


# ── 4. sentencebuilder — repeated tokens, stable positional identity ───────
def test_sentencebuilder_valid_with_repeated_word():
    semantic = {
        "targetSentence": "very very good",
        "tokens": ["very", "very", "good"],
    }
    block, warnings = bfi.validate_sentencebuilder(semantic)
    assert block is not None
    assert len(block["tokens"]) == 3
    ids = [t["id"] for t in block["tokens"]]
    assert len(set(ids)) == 3  # repeated word "very" still gets 2 DISTINCT ids
    positions = [t["targetPosition"] for t in block["tokens"]]
    assert positions == [0, 1, 2]
    assert not any("do_not_reconstruct" in w for w in warnings)


def test_sentencebuilder_token_count_out_of_bounds():
    block, warnings = bfi.validate_sentencebuilder({
        "targetSentence": "hi", "tokens": ["a", "b"],  # below minimum of 3
    })
    assert block is None


def test_sentencebuilder_mismatched_reconstruction_warns_but_keeps_block():
    block, warnings = bfi.validate_sentencebuilder({
        "targetSentence": "Could you send me the report?",
        "tokens": ["totally", "unrelated", "words"],
    })
    assert block is not None  # structurally valid — dropped only for a hard failure
    assert any("do_not_reconstruct" in w for w in warnings)


def test_sentencebuilder_hints_bounded():
    block, _ = bfi.validate_sentencebuilder({
        "targetSentence": "a b c", "tokens": ["a", "b", "c"],
        "hints": ["h1", "h2", "h3", "h4", "h5"],
    })
    assert len(block["hints"]) == bfi._MAX_HINTS


# ── 5. responsechoice ───────────────────────────────────────────────────────
def test_responsechoice_valid_with_unique_option_ids():
    block, warnings = bfi.validate_responsechoice({
        "situation": "Your manager asks you to stay late.",
        "openingLine": "Can you stay until 8?",
        "options": [
            {"text": "Sure.", "consequence": "You feel overworked."},
            {"text": "Can we talk about my schedule?", "consequence": "Seen as assertive.", "recommended": True},
        ],
    })
    assert block is not None
    assert len(block["options"]) == 2
    ids = [o["id"] for o in block["options"]]
    assert len(set(ids)) == 2
    assert block["options"][1]["recommended"] is True


def test_responsechoice_below_minimum_options_dropped():
    block, warnings = bfi.validate_responsechoice({
        "situation": "s", "openingLine": "o",
        "options": [{"text": "only one", "consequence": "c"}],
    })
    assert block is None


# ── 6. branchdialog — full graph validation ────────────────────────────────
def _valid_branch_semantic():
    return {
        "situation": "A client is unhappy with a delayed delivery.",
        "nodes": [
            {"id": "n0", "speaker": "Client", "line": "This happened again.", "choices": [
                {"text": "I understand.", "next": "n1a"},
                {"text": "Not our fault.", "next": "n1b"},
            ]},
            {"id": "n1a", "speaker": "Client", "line": "Thank you.", "choices": []},
            {"id": "n1b", "speaker": "Client", "line": "Not good enough.", "choices": []},
        ],
    }


def test_branchdialog_valid_graph():
    block, warnings = bfi.validate_branchdialog(_valid_branch_semantic())
    assert block is not None
    assert block["rootId"] == "n0"
    assert len(block["nodes"]) == 3
    assert warnings == []


def test_branchdialog_missing_next_target_dropped():
    semantic = _valid_branch_semantic()
    semantic["nodes"][0]["choices"][0]["next"] = "does_not_exist"
    block, warnings = bfi.validate_branchdialog(semantic)
    assert block is None
    assert "branchdialog_choice_missing_text_or_unresolved_next" in warnings


def test_branchdialog_cycle_detected_dropped():
    semantic = {
        "situation": "s",
        "nodes": [
            {"id": "n0", "speaker": "A", "line": "l0", "choices": [{"text": "go", "next": "n1"}]},
            {"id": "n1", "speaker": "A", "line": "l1", "choices": [{"text": "back", "next": "n0"}]},
        ],
    }
    block, warnings = bfi.validate_branchdialog(semantic)
    assert block is None
    assert "branchdialog_cycle_detected" in warnings


def test_branchdialog_unreachable_node_dropped():
    semantic = {
        "situation": "s",
        "nodes": [
            {"id": "n0", "speaker": "A", "line": "l0", "choices": []},
            {"id": "n1", "speaker": "A", "line": "l1 unreachable", "choices": []},
        ],
    }
    block, warnings = bfi.validate_branchdialog(semantic)
    assert block is None
    assert "branchdialog_unreachable_node" in warnings


def test_branchdialog_exceeds_max_depth_dropped():
    semantic = {
        "situation": "s",
        "nodes": [
            {"id": "n0", "speaker": "A", "line": "l0", "choices": [{"text": "go", "next": "n1"}]},
            {"id": "n1", "speaker": "A", "line": "l1", "choices": [{"text": "go", "next": "n2"}]},
            {"id": "n2", "speaker": "A", "line": "l2 too deep", "choices": []},
        ],
    }
    block, warnings = bfi.validate_branchdialog(semantic)
    assert block is None
    assert "branchdialog_exceeds_max_depth" in warnings


def test_branchdialog_duplicate_node_ids_dropped():
    semantic = {
        "situation": "s",
        "nodes": [
            {"id": "n0", "speaker": "A", "line": "l0", "choices": []},
            {"id": "n0", "speaker": "A", "line": "duplicate id", "choices": []},
        ],
    }
    block, warnings = bfi.validate_branchdialog(semantic)
    assert block is None
    assert "branchdialog_duplicate_node_ids" in warnings


def test_branchdialog_too_many_choices_per_node_dropped():
    semantic = {
        "situation": "s",
        "nodes": [
            {"id": "n0", "speaker": "A", "line": "l0", "choices": [
                {"text": "a", "next": "n1"}, {"text": "b", "next": "n1"}, {"text": "c", "next": "n1"},
            ]},
            {"id": "n1", "speaker": "A", "line": "l1", "choices": []},
        ],
    }
    block, warnings = bfi.validate_branchdialog(semantic)
    assert block is None
    assert "branchdialog_too_many_choices_in_node" in warnings


# ── 7. checkpoint — semantic-to-canonical MCQ/fillblank mapping ────────────
def test_checkpoint_mcq_uses_existing_contract_exactly():
    chapter_text = "The cat sat on the warm mat by the door."
    semantic = {"items": [{
        "kind": "mcq", "question": "Where did the cat sit?",
        "options": ["on the mat", "on the roof", "in the car"], "correctIndex": 0,
        "evidenceQuote": "The cat sat on the warm mat", "explain": "Stated in the text.",
    }]}
    block, warnings = bfi.validate_checkpoint(semantic, chapter_text=chapter_text)
    assert block is not None
    item = block["items"][0]
    assert item["kind"] == "mcq"
    assert item["text"] == "Where did the cat sit?"        # question -> text
    assert item["answer"] == "on the mat"                    # correctIndex -> full option text
    assert "evidenceQuote" not in item                       # validation-only, stripped
    assert item["explain"] == "Stated in the text."


def test_checkpoint_mcq_ungrounded_evidence_dropped_not_fatal():
    semantic = {"items": [
        {"kind": "mcq", "question": "Q?", "options": ["a", "b"], "correctIndex": 0,
         "evidenceQuote": "not present anywhere", "explain": ""},
        {"kind": "fillblank", "text": "I ___ to school.", "answer": "go", "explain": ""},
    ]}
    block, warnings = bfi.validate_checkpoint(semantic, chapter_text="totally unrelated chapter text")
    assert block is not None
    assert len(block["items"]) == 1
    assert block["items"][0]["kind"] == "fillblank"
    assert any("checkpoint_mcq_dropped" in w for w in warnings)


def test_checkpoint_fillblank_uses_existing_contract():
    semantic = {"items": [{"kind": "fillblank", "text": "I ___ to school.", "answer": "go", "explain": "present tense"}]}
    block, warnings = bfi.validate_checkpoint(semantic)
    assert block["items"][0]["text"] == "I ___ to school."
    assert block["items"][0]["answer"] == "go"


def test_checkpoint_unknown_kind_dropped():
    semantic = {"items": [{"kind": "essay", "text": "write 500 words"}]}
    block, warnings = bfi.validate_checkpoint(semantic)
    assert block is None
    assert any("unknown_item_kind" in w for w in warnings)


def test_checkpoint_stable_item_ids():
    semantic = {"items": [
        {"kind": "fillblank", "text": "a ___ b", "answer": "x"},
        {"kind": "fillblank", "text": "c ___ d", "answer": "y"},
    ]}
    block, _ = bfi.validate_checkpoint(semantic)
    ids = [it["id"] for it in block["items"]]
    assert len(set(ids)) == 2


# ── 8. mission ───────────────────────────────────────────────────────────────
def test_mission_valid():
    block, warnings = bfi.validate_mission({"goal": "Use 'Could you...?' once this week."})
    assert block is not None
    assert block["goal"].startswith("Use")


def test_mission_missing_goal_dropped():
    block, warnings = bfi.validate_mission({"goal": ""})
    assert block is None


# ── 9. reveal ────────────────────────────────────────────────────────────────
def test_reveal_valid():
    block, warnings = bfi.validate_reveal({
        "teaser": "A phrase confident speakers use...",
        "insight": "'I'd love to, but...' softens a refusal.",
    })
    assert block is not None


def test_reveal_missing_insight_dropped():
    block, warnings = bfi.validate_reveal({"teaser": "t", "insight": ""})
    assert block is None


# ── stable-ID generator (§LOCKED CORRECTION 3) ──────────────────────────────
def test_stable_id_prefers_author_hint_when_unique():
    seen = set()
    gen = bfi._stable_id("tok", seen, "author_id_1")
    assert gen == "author_id_1"


def test_stable_id_never_reuses_within_one_call():
    seen = set()
    a = bfi._stable_id("tok", seen, "dup")
    b = bfi._stable_id("tok", seen, "dup")
    assert a != b


def test_stable_id_generated_when_hint_missing():
    seen = set()
    gen = bfi._stable_id("tok", seen, None)
    assert gen.startswith("tok_")


# ── export whitelist sanity (Checkpoint 5 wiring target) ───────────────────
def test_every_validator_type_has_a_whitelist_entry():
    for t in bfi.INTERACTION_BLOCK_TYPES:
        assert t in bfi.INTERACTION_BLOCK_KEY_WHITELIST
        assert t in bfi.VALIDATORS
