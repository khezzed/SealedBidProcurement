import hashlib
import json
import pytest

from conftest import (
    ADDR_BUYER,
    ADDR_OTHER,
    ADDR_VENDOR_A,
    ADDR_VENDOR_B,
    ADDR_VENDOR_C,
    Address,
    MockWebResponse,
    UserError,
    exec_prompt_call_history,
    gl_mock,
    mock_llm_dict,
    mock_llm_responses,
    mock_web_responses,
    set_sender,
    set_time,
)
from contracts.sealed_bid_procurement import (
    MAX_COMMIT_DURATION,
    MAX_EVIDENCE_BYTES,
    MAX_RESERVE_PRICE,
    MAX_REVEAL_ATTEMPTS,
    MAX_REVEAL_DURATION,
    MAX_SPEC_LEN,
    MAX_SUMMARY_LEN,
    MAX_TENDERS,
    MAX_VENDORS_PER_TENDER,
    MIN_COMMIT_DURATION,
    MIN_REVEAL_DURATION,
    SealedBidProcurement,
    _evaluate_bid_locally,
    compute_commitment_hash,
    compute_vickrey_settlement,
    is_valid_evidence_url,
)

SAMPLE_URL_A = (
    "https://raw.githubusercontent.com/test-org/specs/0123456789abcdef0123456789abcdef01234567/spec_a.txt"
)
SAMPLE_URL_B = (
    "https://raw.githubusercontent.com/test-org/specs/0123456789abcdef0123456789abcdef01234567/spec_b.txt"
)
SAMPLE_URL_C = (
    "https://raw.githubusercontent.com/test-org/specs/0123456789abcdef0123456789abcdef01234567/spec_c.txt"
)


# =============================================================================
# 1. Unit Tests for Deterministic Helpers
# =============================================================================
def test_compute_commitment_hash_basic():
    tender_id = 1
    vendor = "0x2222222222222222222222222222222222222222"
    price = 180
    url = SAMPLE_URL_A
    summary = "High performance microservice meeting spec"
    salt = "secret_salt_123"

    expected_preimage = f"{tender_id}|{vendor.lower()}|{price}|{url}|{summary}|{salt}"
    expected_hash = hashlib.sha256(expected_preimage.encode("utf-8")).hexdigest()

    actual_hash = compute_commitment_hash(tender_id, vendor, price, url, summary, salt)
    assert actual_hash == expected_hash

    # Case insensitivity on vendor address
    mixed_vendor = "0x2222222222222222222222222222222222222222".upper()
    assert compute_commitment_hash(tender_id, mixed_vendor, price, url, summary, salt) == expected_hash

    # Altering any single field changes hash
    assert compute_commitment_hash(2, vendor, price, url, summary, salt) != expected_hash
    assert compute_commitment_hash(tender_id, str(ADDR_VENDOR_B), price, url, summary, salt) != expected_hash
    assert compute_commitment_hash(tender_id, vendor, 181, url, summary, salt) != expected_hash
    assert compute_commitment_hash(tender_id, vendor, price, SAMPLE_URL_B, summary, salt) != expected_hash
    assert compute_commitment_hash(tender_id, vendor, price, url, "Different summary", salt) != expected_hash
    assert compute_commitment_hash(tender_id, vendor, price, url, summary, "other_salt") != expected_hash

    # View method matches helper output
    contract = SealedBidProcurement()
    assert (
        contract.get_commitment_hash(tender_id, vendor, price, url, summary, salt)
        == expected_hash
    )


def test_compute_vickrey_settlement_three_bids_lowball_ineligible():
    # 3 bids: lowball Vendor B (120, INELIGIBLE), Vendor A (180, ELIGIBLE), Vendor C (240, ELIGIBLE)
    revealed_bids = [
        {
            "vendor": str(ADDR_VENDOR_B),
            "price": 120,
            "reveal_order": 1,
            "entailment": "SUPPORTED",
            "eligibility": "INELIGIBLE",
        },
        {
            "vendor": str(ADDR_VENDOR_A),
            "price": 180,
            "reveal_order": 2,
            "entailment": "SUPPORTED",
            "eligibility": "ELIGIBLE",
        },
        {
            "vendor": str(ADDR_VENDOR_C),
            "price": 240,
            "reveal_order": 3,
            "entailment": "SUPPORTED",
            "eligibility": "ELIGIBLE",
        },
    ]
    reserve_price = 300
    res = compute_vickrey_settlement(revealed_bids, reserve_price)
    assert res["outcome"] == "AWARDED"
    assert res["winner"] == str(ADDR_VENDOR_A)
    assert res["winning_bid"] == 180
    assert res["clearing_price"] == 240  # Second-price among ELIGIBLE bids only!
    assert res["savings"] == 300 - 240  # 60
    assert res["eligible_count"] == 2


def test_compute_vickrey_settlement_single_eligible_bid():
    revealed_bids = [
        {
            "vendor": str(ADDR_VENDOR_A),
            "price": 180,
            "reveal_order": 1,
            "entailment": "SUPPORTED",
            "eligibility": "ELIGIBLE",
        }
    ]
    reserve_price = 300
    res = compute_vickrey_settlement(revealed_bids, reserve_price)
    assert res["outcome"] == "AWARDED"
    assert res["winner"] == str(ADDR_VENDOR_A)
    assert res["winning_bid"] == 180
    assert res["clearing_price"] == 300  # Capped at reserve_price
    assert res["savings"] == 0
    assert res["eligible_count"] == 1


def test_compute_vickrey_settlement_tie_price():
    revealed_bids = [
        {
            "vendor": str(ADDR_VENDOR_A),
            "price": 180,
            "reveal_order": 1,
            "entailment": "SUPPORTED",
            "eligibility": "ELIGIBLE",
        },
        {
            "vendor": str(ADDR_VENDOR_B),
            "price": 180,
            "reveal_order": 2,
            "entailment": "SUPPORTED",
            "eligibility": "ELIGIBLE",
        },
    ]
    reserve_price = 300
    res = compute_vickrey_settlement(revealed_bids, reserve_price)
    assert res["outcome"] == "AWARDED"
    assert res["winner"] == str(ADDR_VENDOR_A)  # Broken deterministically by reveal_order
    assert res["winning_bid"] == 180
    assert res["clearing_price"] == 180
    assert res["savings"] == 120
    assert res["eligible_count"] == 2


def test_compute_vickrey_settlement_all_ineligible_or_unclear():
    revealed_bids = [
        {
            "vendor": str(ADDR_VENDOR_A),
            "price": 180,
            "reveal_order": 1,
            "entailment": "UNSUPPORTED",
            "eligibility": "UNCLEAR",
        },
        {
            "vendor": str(ADDR_VENDOR_B),
            "price": 200,
            "reveal_order": 2,
            "entailment": "SUPPORTED",
            "eligibility": "INELIGIBLE",
        },
        {
            "vendor": str(ADDR_VENDOR_C),
            "price": 250,
            "reveal_order": 3,
            "entailment": "SUPPORTED",
            "eligibility": "UNCLEAR",
        },
    ]
    reserve_price = 300
    res = compute_vickrey_settlement(revealed_bids, reserve_price)
    assert res["outcome"] == "NO_ELIGIBLE_WINNER"
    assert res["winner"] == ""
    assert res["winning_bid"] == 0
    assert res["clearing_price"] == 0
    assert res["savings"] == 0
    assert res["eligible_count"] == 0


def test_compute_vickrey_settlement_empty():
    res = compute_vickrey_settlement([], 500)
    assert res["outcome"] == "NO_ELIGIBLE_WINNER"
    assert res["winner"] == ""
    assert res["winning_bid"] == 0
    assert res["clearing_price"] == 0
    assert res["savings"] == 0
    assert res["eligible_count"] == 0


# =============================================================================
# 2. E2E Auction & Lowball Disqualification Flow
# =============================================================================
def test_e2e_auction_and_lowball_disqualification():
    contract = SealedBidProcurement()
    start_time = 1700000000
    set_time(start_time)
    set_sender(ADDR_BUYER)

    # 1. Buyer opens tender
    requirements = "Mandatory: Sub-50ms latency, TLS 1.3 only, 99.99% SLA."
    reserve_price = 500
    commit_dur = 120
    reveal_dur = 120
    tender_id = contract.open_tender(
        "Low-Latency API Gateway", requirements, reserve_price, commit_dur, reveal_dur
    )
    assert tender_id == 1
    assert contract.get_tender_count() == 1

    # Prepare bids data
    # Vendor B: lowball price 120, non-compliant (omits TLS 1.3)
    sum_b = "API gateway with 40ms latency and 99.99% SLA, HTTP/2."
    salt_b = "salt_vendor_b_001"
    ev_bytes_b = b"Architecture doc: Gateway delivers 40ms latency, 99.99% uptime, HTTP/2 without TLS 1.3."
    mock_web_responses[SAMPLE_URL_B] = MockWebResponse(status=200, body=ev_bytes_b)

    # Vendor A: compliant price 210
    sum_a = "API gateway with 35ms latency, TLS 1.3 enforced, 99.995% SLA."
    salt_a = "salt_vendor_a_002"
    ev_bytes_a = b"Specification: Gateway achieves 35ms p99 latency, strict TLS 1.3, 99.995% guaranteed SLA."
    mock_web_responses[SAMPLE_URL_A] = MockWebResponse(status=200, body=ev_bytes_a)

    # Vendor C: compliant price 340
    sum_c = "Enterprise API gateway with 45ms latency, TLS 1.3, 99.99% SLA."
    salt_c = "salt_vendor_c_003"
    ev_bytes_c = b"Audit report: Confirmed 45ms latency, TLS 1.3 cipher suites, 99.99% availability."
    mock_web_responses[SAMPLE_URL_C] = MockWebResponse(status=200, body=ev_bytes_c)

    # Mock LLM evaluations
    def llm_handler(prompt: str):
        if "<TECHNICAL_SUMMARY>" in prompt:
            # Call 1: Entailment
            return json.dumps({"entailment": "SUPPORTED"})
        elif "<MANDATORY_REQUIREMENTS>" in prompt:
            # Call 2: Eligibility
            if "HTTP/2 without TLS 1.3" in prompt or sum_b in prompt:
                return json.dumps({"eligibility": "INELIGIBLE"})
            return json.dumps({"eligibility": "ELIGIBLE"})
        raise RuntimeError("Unrecognized prompt")

    mock_llm_responses.append(llm_handler)

    # 2. Commit Phase (now < start_time + 120)
    hash_b = compute_commitment_hash(tender_id, str(ADDR_VENDOR_B), 120, SAMPLE_URL_B, sum_b, salt_b)
    set_sender(ADDR_VENDOR_B)
    res_cb = contract.commit_bid(tender_id, hash_b)
    assert res_cb == f"COMMITTED:TENDER_1:VENDOR_{str(ADDR_VENDOR_B).lower()}"

    hash_a = compute_commitment_hash(tender_id, str(ADDR_VENDOR_A), 210, SAMPLE_URL_A, sum_a, salt_a)
    set_sender(ADDR_VENDOR_A)
    res_ca = contract.commit_bid(tender_id, hash_a)
    assert res_ca == f"COMMITTED:TENDER_1:VENDOR_{str(ADDR_VENDOR_A).lower()}"

    hash_c = compute_commitment_hash(tender_id, str(ADDR_VENDOR_C), 340, SAMPLE_URL_C, sum_c, salt_c)
    set_sender(ADDR_VENDOR_C)
    res_cc = contract.commit_bid(tender_id, hash_c)
    assert res_cc == f"COMMITTED:TENDER_1:VENDOR_{str(ADDR_VENDOR_C).lower()}"

    # 3. Advance time to Reveal Window (commit_deadline <= now < reveal_deadline)
    reveal_time = start_time + 125  # 120 <= 125 < 240
    set_time(reveal_time)

    # Vendor B reveals lowball non-compliant bid
    set_sender(ADDR_VENDOR_B)
    rev_b = contract.reveal_and_evaluate(tender_id, 120, SAMPLE_URL_B, sum_b, salt_b)
    assert rev_b == "REVEALED:ELIGIBILITY_INELIGIBLE:PRICE_120"

    # Vendor A reveals compliant bid
    set_sender(ADDR_VENDOR_A)
    rev_a = contract.reveal_and_evaluate(tender_id, 210, SAMPLE_URL_A, sum_a, salt_a)
    assert rev_a == "REVEALED:ELIGIBILITY_ELIGIBLE:PRICE_210"

    # Vendor C reveals compliant bid
    set_sender(ADDR_VENDOR_C)
    rev_c = contract.reveal_and_evaluate(tender_id, 340, SAMPLE_URL_C, sum_c, salt_c)
    assert rev_c == "REVEALED:ELIGIBILITY_ELIGIBLE:PRICE_340"

    # 4. Advance time past reveal_deadline (now >= start_time + 240)
    settle_time = start_time + 245
    set_time(settle_time)

    # Permissionless resolution by anyone
    set_sender(ADDR_OTHER)
    settle_res = contract.settle_tender(tender_id)
    assert settle_res == f"SETTLED:AWARDED:WINNER_{str(ADDR_VENDOR_A)}:CLEARING_340"

    # Verify final tender state
    tender_json = contract.get_tender(tender_id)
    tender_data = json.loads(tender_json)
    assert tender_data["status"] == "AWARDED"
    assert tender_data["settlement"]["winner"] == str(ADDR_VENDOR_A)
    assert tender_data["settlement"]["winning_bid"] == 210
    assert tender_data["settlement"]["clearing_price"] == 340
    assert tender_data["settlement"]["savings"] == 160  # 500 - 340
    assert tender_data["settlement"]["eligible_count"] == 2

    # Check bids inspection
    revealed = tender_data["revealed_bids"]
    assert len(revealed) == 3
    assert revealed[0]["vendor"] == str(ADDR_VENDOR_B)
    assert revealed[0]["eligibility"] == "INELIGIBLE"
    assert revealed[0]["evidence_digest"] == hashlib.sha256(ev_bytes_b).hexdigest()

    assert revealed[1]["vendor"] == str(ADDR_VENDOR_A)
    assert revealed[1]["eligibility"] == "ELIGIBLE"
    assert revealed[1]["evidence_digest"] == hashlib.sha256(ev_bytes_a).hexdigest()

    assert revealed[2]["vendor"] == str(ADDR_VENDOR_C)
    assert revealed[2]["eligibility"] == "ELIGIBLE"


# =============================================================================
# 3. Adversarial Leader Tests
# =============================================================================
def test_adversarial_leader_forged_digest():
    contract = SealedBidProcurement()
    set_time(1700000000)
    set_sender(ADDR_BUYER)

    tender_id = contract.open_tender("Test Tender", "Spec", 500, 100, 100)

    summary = "Valid technical summary"
    salt = "salt123"
    body = b"Valid evidence content"
    mock_web_responses[SAMPLE_URL_A] = MockWebResponse(status=200, body=body)
    mock_llm_dict["TECHNICAL_SUMMARY"] = json.dumps({"entailment": "SUPPORTED"})
    mock_llm_dict["MANDATORY_REQUIREMENTS"] = json.dumps({"eligibility": "ELIGIBLE"})

    h = compute_commitment_hash(tender_id, str(ADDR_VENDOR_A), 200, SAMPLE_URL_A, summary, salt)
    set_sender(ADDR_VENDOR_A)
    contract.commit_bid(tender_id, h)

    set_time(1700000105)

    # Adversarial leader forges digest
    def tamper_digest(leader_res):
        d = dict(leader_res)
        d["digest"] = "0000000000000000000000000000000000000000000000000000000000000000"
        return d

    gl_mock.adversarial_leader_fn = tamper_digest

    with pytest.raises(UserError) as exc_info:
        contract.reveal_and_evaluate(tender_id, 200, SAMPLE_URL_A, summary, salt)
    assert "CONSENSUS_VALIDATION_FAILED" in str(exc_info.value)


def test_adversarial_leader_forged_eligibility():
    contract = SealedBidProcurement()
    set_time(1700000000)
    set_sender(ADDR_BUYER)

    tender_id = contract.open_tender("Test Tender", "Strict spec", 500, 100, 100)

    summary = "Non-compliant summary"
    salt = "salt123"
    body = b"Evidence body"
    mock_web_responses[SAMPLE_URL_A] = MockWebResponse(status=200, body=body)

    # Truth is INELIGIBLE
    mock_llm_dict["TECHNICAL_SUMMARY"] = json.dumps({"entailment": "SUPPORTED"})
    mock_llm_dict["MANDATORY_REQUIREMENTS"] = json.dumps({"eligibility": "INELIGIBLE"})

    h = compute_commitment_hash(tender_id, str(ADDR_VENDOR_A), 200, SAMPLE_URL_A, summary, salt)
    set_sender(ADDR_VENDOR_A)
    contract.commit_bid(tender_id, h)

    set_time(1700000105)

    # Leader attempts to forge eligibility to ELIGIBLE
    def tamper_eligibility(leader_res):
        d = dict(leader_res)
        d["eligibility"] = "ELIGIBLE"
        return d

    gl_mock.adversarial_leader_fn = tamper_eligibility

    with pytest.raises(UserError) as exc_info:
        contract.reveal_and_evaluate(tender_id, 200, SAMPLE_URL_A, summary, salt)
    assert "CONSENSUS_VALIDATION_FAILED" in str(exc_info.value)


def test_invented_llm_labels_normalized_to_unclear():
    # LLM returns hallucinatory / invented labels
    body = b"Some evidence"
    mock_web_responses[SAMPLE_URL_A] = MockWebResponse(status=200, body=body)

    # Call 1: invented label
    mock_llm_dict["TECHNICAL_SUMMARY"] = json.dumps({"entailment": "TOTALLY_ACCURATE"})
    mock_llm_dict["MANDATORY_REQUIREMENTS"] = json.dumps({"eligibility": "PASS"})

    res = _evaluate_bid_locally("Requirements", "Summary", SAMPLE_URL_A)
    assert res["entailment"] == "UNCLEAR"
    assert res["eligibility"] == "UNCLEAR"

    # Call 1 supported, Call 2 invented label
    mock_llm_dict["TECHNICAL_SUMMARY"] = json.dumps({"entailment": "SUPPORTED"})
    mock_llm_dict["MANDATORY_REQUIREMENTS"] = json.dumps({"eligibility": "MAYBE_COMPLIANT"})

    res2 = _evaluate_bid_locally("Requirements", "Summary", SAMPLE_URL_A)
    assert res2["entailment"] == "SUPPORTED"
    assert res2["eligibility"] == "UNCLEAR"


def test_unsupported_entailment_skips_call_2():
    body = b"Evidence that fails to entail summary"
    mock_web_responses[SAMPLE_URL_A] = MockWebResponse(status=200, body=body)

    exec_prompt_call_history.clear()
    mock_llm_dict["TECHNICAL_SUMMARY"] = json.dumps({"entailment": "UNSUPPORTED"})

    res = _evaluate_bid_locally("Requirements", "Summary", SAMPLE_URL_A)
    assert res["entailment"] == "UNSUPPORTED"
    assert res["eligibility"] == "UNCLEAR"
    # Call 2 was skipped: exec_prompt called exactly once
    assert len(exec_prompt_call_history) == 1
    assert "<TECHNICAL_SUMMARY>" in exec_prompt_call_history[0]
    assert "<MANDATORY_REQUIREMENTS>" not in exec_prompt_call_history[0]


# =============================================================================
# 4. Commitment, Phase, Replay & Bound Guards
# =============================================================================
def test_commitment_mismatch_guards():
    contract = SealedBidProcurement()
    set_time(1700000000)
    set_sender(ADDR_BUYER)

    tender_id = contract.open_tender("Procurement", "Spec", 500, 100, 100)
    summary = "Genuine summary"
    salt = "secret_salt"
    price = 200
    url = SAMPLE_URL_A
    body = b"Evidence bytes"
    mock_web_responses[url] = MockWebResponse(status=200, body=body)

    h = compute_commitment_hash(tender_id, str(ADDR_VENDOR_A), price, url, summary, salt)
    set_sender(ADDR_VENDOR_A)
    contract.commit_bid(tender_id, h)

    set_time(1700000110)

    # Altered price
    with pytest.raises(UserError) as exc:
        contract.reveal_and_evaluate(tender_id, 190, url, summary, salt)
    assert "COMMITMENT_MISMATCH" in str(exc.value)

    # Altered URL
    with pytest.raises(UserError) as exc:
        contract.reveal_and_evaluate(tender_id, price, SAMPLE_URL_B, summary, salt)
    assert "COMMITMENT_MISMATCH" in str(exc.value)

    # Altered summary
    with pytest.raises(UserError) as exc:
        contract.reveal_and_evaluate(tender_id, price, url, "Different summary", salt)
    assert "COMMITMENT_MISMATCH" in str(exc.value)

    # Altered salt
    with pytest.raises(UserError) as exc:
        contract.reveal_and_evaluate(tender_id, price, url, summary, "wrong_salt")
    assert "COMMITMENT_MISMATCH" in str(exc.value)


def test_phase_guards():
    contract = SealedBidProcurement()
    start = 1700000000
    set_time(start)
    set_sender(ADDR_BUYER)

    tender_id = contract.open_tender("Tender", "Spec", 500, 100, 100)
    summary = "Summary"
    salt = "salt"
    url = SAMPLE_URL_A
    body = b"Evidence"
    mock_web_responses[url] = MockWebResponse(status=200, body=body)

    h = compute_commitment_hash(tender_id, str(ADDR_VENDOR_A), 200, url, summary, salt)
    set_sender(ADDR_VENDOR_A)
    contract.commit_bid(tender_id, h)

    # 1. Reveal before commit_deadline
    set_time(start + 50)
    with pytest.raises(UserError) as exc:
        contract.reveal_and_evaluate(tender_id, 200, url, summary, salt)
    assert "COMMIT_PHASE_NOT_ENDED" in str(exc.value)

    # 2. Commit after commit_deadline
    set_time(start + 105)
    set_sender(ADDR_VENDOR_B)
    hb = compute_commitment_hash(tender_id, str(ADDR_VENDOR_B), 250, url, summary, salt)
    with pytest.raises(UserError) as exc:
        contract.commit_bid(tender_id, hb)
    assert "COMMIT_PHASE_ENDED" in str(exc.value)

    # 3. Settle before reveal_deadline
    with pytest.raises(UserError) as exc:
        contract.settle_tender(tender_id)
    assert "REVEAL_PHASE_NOT_ENDED" in str(exc.value)

    # 4. Reveal after reveal_deadline
    set_time(start + 210)
    set_sender(ADDR_VENDOR_A)
    with pytest.raises(UserError) as exc:
        contract.reveal_and_evaluate(tender_id, 200, url, summary, salt)
    assert "REVEAL_PHASE_ENDED" in str(exc.value)


def test_duplicate_commit_and_reveal():
    contract = SealedBidProcurement()
    start = 1700000000
    set_time(start)
    set_sender(ADDR_BUYER)

    tender_id = contract.open_tender("Tender", "Spec", 500, 100, 100)
    summary = "Summary"
    salt = "salt"
    url = SAMPLE_URL_A
    body = b"Evidence"
    mock_web_responses[url] = MockWebResponse(status=200, body=body)
    mock_llm_dict["TECHNICAL_SUMMARY"] = json.dumps({"entailment": "SUPPORTED"})
    mock_llm_dict["MANDATORY_REQUIREMENTS"] = json.dumps({"eligibility": "ELIGIBLE"})

    h = compute_commitment_hash(tender_id, str(ADDR_VENDOR_A), 200, url, summary, salt)
    set_sender(ADDR_VENDOR_A)
    contract.commit_bid(tender_id, h)

    # Duplicate commit
    with pytest.raises(UserError) as exc:
        contract.commit_bid(tender_id, h)
    assert "ALREADY_COMMITTED" in str(exc.value)

    set_time(start + 110)
    contract.reveal_and_evaluate(tender_id, 200, url, summary, salt)

    # Duplicate reveal
    with pytest.raises(UserError) as exc:
        contract.reveal_and_evaluate(tender_id, 200, url, summary, salt)
    assert "ALREADY_REVEALED" in str(exc.value)


def test_reveal_without_commitment():
    contract = SealedBidProcurement()
    start = 1700000000
    set_time(start)
    set_sender(ADDR_BUYER)

    tender_id = contract.open_tender("Tender", "Spec", 500, 100, 100)
    set_time(start + 110)
    set_sender(ADDR_VENDOR_B)

    with pytest.raises(UserError) as exc:
        contract.reveal_and_evaluate(tender_id, 200, SAMPLE_URL_A, "Summary", "salt")
    assert "NO_COMMITMENT_FOUND" in str(exc.value)


def test_invalid_bid_price():
    contract = SealedBidProcurement()
    start = 1700000000
    set_time(start)
    set_sender(ADDR_BUYER)

    tender_id = contract.open_tender("Tender", "Spec", 500, 100, 100)
    summary = "Summary"
    salt = "salt"
    url = SAMPLE_URL_A
    body = b"Evidence"
    mock_web_responses[url] = MockWebResponse(status=200, body=body)

    # Exceeding reserve price (501 > 500)
    h_excess = compute_commitment_hash(tender_id, str(ADDR_VENDOR_A), 501, url, summary, salt)
    set_sender(ADDR_VENDOR_A)
    contract.commit_bid(tender_id, h_excess)

    set_time(start + 110)
    with pytest.raises(UserError) as exc:
        contract.reveal_and_evaluate(tender_id, 501, url, summary, salt)
    assert "INVALID_BID_PRICE" in str(exc.value)

    # Zero or negative price
    h_zero = compute_commitment_hash(tender_id, str(ADDR_VENDOR_B), 0, url, summary, salt)
    set_time(start)
    set_sender(ADDR_VENDOR_B)
    contract.commit_bid(tender_id, h_zero)

    set_time(start + 110)
    with pytest.raises(UserError) as exc:
        contract.reveal_and_evaluate(tender_id, 0, url, summary, salt)
    assert "INVALID_BID_PRICE" in str(exc.value)


def test_double_settle():
    contract = SealedBidProcurement()
    start = 1700000000
    set_time(start)
    set_sender(ADDR_BUYER)

    tender_id = contract.open_tender("Tender", "Spec", 500, 100, 100)
    set_time(start + 210)
    contract.settle_tender(tender_id)

    # Double settle
    with pytest.raises(UserError) as exc:
        contract.settle_tender(tender_id)
    assert "TENDER_ALREADY_SETTLED" in str(exc.value)


def test_max_vendors_per_tender():
    contract = SealedBidProcurement()
    set_time(1700000000)
    set_sender(ADDR_BUYER)

    tender_id = contract.open_tender("Tender", "Spec", 500, 100, 100)
    summary = "Summary"
    salt = "salt"

    for i in range(MAX_VENDORS_PER_TENDER):
        addr_str = f"0x{i+1:040x}"
        set_sender(Address(addr_str))
        h = compute_commitment_hash(tender_id, addr_str, 200, SAMPLE_URL_A, summary, salt)
        contract.commit_bid(tender_id, h)

    # 13th vendor fails
    addr_13 = f"0x{MAX_VENDORS_PER_TENDER + 1:040x}"
    set_sender(Address(addr_13))
    h_13 = compute_commitment_hash(tender_id, addr_13, 200, SAMPLE_URL_A, summary, salt)
    with pytest.raises(UserError) as exc:
        contract.commit_bid(tender_id, h_13)
    assert "MAX_VENDORS_EXCEEDED" in str(exc.value)


def test_max_tenders():
    contract = SealedBidProcurement()
    set_time(1700000000)
    set_sender(ADDR_BUYER)

    for i in range(MAX_TENDERS):
        t_id = contract.open_tender(f"Tender {i+1}", "Spec", 500, 100, 100)
        assert t_id == i + 1

    # 17th tender fails
    with pytest.raises(UserError) as exc:
        contract.open_tender("Tender Overflow", "Spec", 500, 100, 100)
    assert "MAX_TENDERS_EXCEEDED" in str(exc.value)


def test_missing_block_time():
    contract = SealedBidProcurement()
    set_sender(ADDR_BUYER)
    set_time(None)  # Simulates missing block time

    with pytest.raises(UserError) as exc:
        contract.open_tender("Tender", "Spec", 500, 100, 100)
    assert "NO_BLOCK_TIME" in str(exc.value)


def test_open_tender_bounds():
    contract = SealedBidProcurement()
    set_time(1700000000)
    set_sender(ADDR_BUYER)

    # Title bounds
    with pytest.raises(UserError) as exc:
        contract.open_tender("", "Spec", 500, 100, 100)
    assert "INVALID_TITLE_LENGTH" in str(exc.value)

    with pytest.raises(UserError) as exc:
        contract.open_tender("A" * 81, "Spec", 500, 100, 100)
    assert "INVALID_TITLE_LENGTH" in str(exc.value)

    # Spec bounds
    with pytest.raises(UserError) as exc:
        contract.open_tender("Valid Title", "", 500, 100, 100)
    assert "INVALID_SPEC_LENGTH" in str(exc.value)

    with pytest.raises(UserError) as exc:
        contract.open_tender("Valid Title", "A" * (MAX_SPEC_LEN + 1), 500, 100, 100)
    assert "INVALID_SPEC_LENGTH" in str(exc.value)

    # Reserve price bounds
    with pytest.raises(UserError) as exc:
        contract.open_tender("Valid Title", "Spec", 0, 100, 100)
    assert "INVALID_RESERVE_PRICE" in str(exc.value)

    with pytest.raises(UserError) as exc:
        contract.open_tender("Valid Title", "Spec", MAX_RESERVE_PRICE + 1, 100, 100)
    assert "INVALID_RESERVE_PRICE" in str(exc.value)

    # Durations bounds
    with pytest.raises(UserError) as exc:
        contract.open_tender("Valid Title", "Spec", 500, MIN_COMMIT_DURATION - 1, 100)
    assert "INVALID_COMMIT_DURATION" in str(exc.value)

    with pytest.raises(UserError) as exc:
        contract.open_tender("Valid Title", "Spec", 500, MAX_COMMIT_DURATION + 1, 100)
    assert "INVALID_COMMIT_DURATION" in str(exc.value)

    with pytest.raises(UserError) as exc:
        contract.open_tender("Valid Title", "Spec", 500, 100, MIN_REVEAL_DURATION - 1)
    assert "INVALID_REVEAL_DURATION" in str(exc.value)

    with pytest.raises(UserError) as exc:
        contract.open_tender("Valid Title", "Spec", 500, 100, MAX_REVEAL_DURATION + 1)
    assert "INVALID_REVEAL_DURATION" in str(exc.value)


# =============================================================================
# 5. Evidence Failures & URL Validation
# =============================================================================
def test_evidence_failures_http_errors():
    mock_web_responses[SAMPLE_URL_A] = MockWebResponse(status=404, body=b"Not found")
    res404 = _evaluate_bid_locally("Requirements", "Summary", SAMPLE_URL_A)
    assert res404["fetch"] == "HTTP_404"
    assert res404["eligibility"] == "UNCLEAR"

    mock_web_responses[SAMPLE_URL_A] = MockWebResponse(status=500, body=b"Server error")
    res500 = _evaluate_bid_locally("Requirements", "Summary", SAMPLE_URL_A)
    assert res500["fetch"] == "HTTP_500"
    assert res500["eligibility"] == "UNCLEAR"


def test_evidence_failures_empty_body():
    mock_web_responses[SAMPLE_URL_A] = MockWebResponse(status=200, body=b"")
    res = _evaluate_bid_locally("Requirements", "Summary", SAMPLE_URL_A)
    assert res["fetch"] == "EMPTY"
    assert res["eligibility"] == "UNCLEAR"


def test_evidence_failures_oversized():
    mock_web_responses[SAMPLE_URL_A] = MockWebResponse(
        status=200, body=b"A" * (MAX_EVIDENCE_BYTES + 1)
    )
    res = _evaluate_bid_locally("Requirements", "Summary", SAMPLE_URL_A)
    assert res["fetch"] == "OVERSIZED"
    assert res["eligibility"] == "UNCLEAR"


def test_evidence_failures_bad_utf8():
    mock_web_responses[SAMPLE_URL_A] = MockWebResponse(
        status=200, body=b"\xff\xfe\x00\x00\x80\x81"
    )
    res = _evaluate_bid_locally("Requirements", "Summary", SAMPLE_URL_A)
    assert res["fetch"] == "BAD_UTF8"
    assert res["eligibility"] == "UNCLEAR"


def test_evidence_failures_fetch_exception():
    mock_web_responses[SAMPLE_URL_A] = RuntimeError("Connection dropped")
    res = _evaluate_bid_locally("Requirements", "Summary", SAMPLE_URL_A)
    assert res["fetch"] == "FETCH_ERROR"
    assert res["eligibility"] == "UNCLEAR"


def test_evidence_url_validation():
    # Valid URL
    assert is_valid_evidence_url(SAMPLE_URL_A)

    # Unpinned branch name instead of 40-hex SHA
    branch_url = "https://raw.githubusercontent.com/owner/repo/main/spec.txt"
    assert not is_valid_evidence_url(branch_url)

    # Query string
    assert not is_valid_evidence_url(SAMPLE_URL_A + "?token=secret")

    # Fragment
    assert not is_valid_evidence_url(SAMPLE_URL_A + "#section1")

    # Dot dot
    assert not is_valid_evidence_url(
        "https://raw.githubusercontent.com/owner/repo/0123456789abcdef0123456789abcdef01234567/../spec.txt"
    )

    # Non-github host
    assert not is_valid_evidence_url(
        "https://evil.com/owner/repo/0123456789abcdef0123456789abcdef01234567/spec.txt"
    )

    # Short SHA
    assert not is_valid_evidence_url(
        "https://raw.githubusercontent.com/owner/repo/0123456789abcdef/spec.txt"
    )


def test_max_reveal_attempts():
    contract = SealedBidProcurement()
    start = 1700000000
    set_time(start)
    set_sender(ADDR_BUYER)

    tender_id = contract.open_tender("Tender", "Spec", 500, 100, 100)
    summary = "Summary"
    salt = "salt"
    url = SAMPLE_URL_A
    body = b"Evidence"
    mock_web_responses[url] = MockWebResponse(status=200, body=body)
    mock_llm_dict["TECHNICAL_SUMMARY"] = json.dumps({"entailment": "SUPPORTED"})
    mock_llm_dict["MANDATORY_REQUIREMENTS"] = json.dumps({"eligibility": "ELIGIBLE"})

    # Set tender reveal_attempts directly to MAX_REVEAL_ATTEMPTS
    tender_data = json.loads(contract.get_tender(tender_id))
    tender_data["reveal_attempts"] = MAX_REVEAL_ATTEMPTS
    # Register a commit for ADDR_VENDOR_A
    h = compute_commitment_hash(tender_id, str(ADDR_VENDOR_A), 200, url, summary, salt)
    tender_data["commits"][str(ADDR_VENDOR_A).lower()] = {
        "vendor": str(ADDR_VENDOR_A),
        "commitment_hash": h,
        "committed_at": start,
        "revealed": False,
    }
    contract.tenders[contract.tender_counter] = json.dumps(tender_data)

    set_time(start + 110)
    set_sender(ADDR_VENDOR_A)
    with pytest.raises(UserError) as exc:
        contract.reveal_and_evaluate(tender_id, 200, url, summary, salt)
    assert "MAX_REVEAL_ATTEMPTS_EXCEEDED" in str(exc.value)


def test_invalid_commitment_hash_format():
    contract = SealedBidProcurement()
    set_time(1700000000)
    set_sender(ADDR_BUYER)

    tender_id = contract.open_tender("Tender", "Spec", 500, 100, 100)
    set_sender(ADDR_VENDOR_A)

    # Short hash
    with pytest.raises(UserError) as exc:
        contract.commit_bid(tender_id, "abcdef")
    assert "INVALID_COMMITMENT_HASH" in str(exc.value)

    # Uppercase hex
    with pytest.raises(UserError) as exc:
        contract.commit_bid(tender_id, "A" * 64)
    assert "INVALID_COMMITMENT_HASH" in str(exc.value)

    # Non-hex characters
    with pytest.raises(UserError) as exc:
        contract.commit_bid(tender_id, "g" * 64)
    assert "INVALID_COMMITMENT_HASH" in str(exc.value)


def test_views_and_not_found():
    contract = SealedBidProcurement()
    set_time(1700000000)
    set_sender(ADDR_BUYER)

    assert contract.get_tender_count() == 0
    with pytest.raises(UserError) as exc:
        contract.get_tender(999)
    assert "TENDER_NOT_FOUND" in str(exc.value)

    t_id = contract.open_tender("Tender 1", "Spec", 500, 100, 100)
    assert contract.get_tender_count() == 1

    tender_raw = contract.get_tender(t_id)
    tender_data = json.loads(tender_raw)
    assert tender_data["id"] == t_id
    assert tender_data["title"] == "Tender 1"
    assert tender_data["buyer"] == str(ADDR_BUYER)
