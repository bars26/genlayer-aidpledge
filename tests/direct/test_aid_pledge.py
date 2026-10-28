"""Direct-mode tests for the AidPledge contract."""

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone

import pytest

from tests.direct.conftest import to_hex

CONTRACT_PATH = "contracts/aid_pledge.py"
GEN = 10**18
FTS = "https://api.hpc.tools/v1/public"
UK, SUDAN = "2917", "1220"
UK_NAME = "United Kingdom, Government of"
URL = "https://www.gov.uk/government/news/uk-announces-new-humanitarian-funding-for-sudan"
DEADLINE = "2026-03-31"
TARGET = 150_000_000


def _sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _days_from_now(n):
    return (datetime.now(timezone.utc) + timedelta(days=n)).strftime("%Y-%m-%d")


def _mock(direct_vm, url, body, status=200, raw=None):
    payload = raw.encode() if raw is not None else json.dumps(body).encode()
    direct_vm.mock_web("^" + re.escape(url) + "$", {"method": "GET", "response": {
        "status": status, "headers": {"Content-Type": b"application/json"}, "body": payload}})


def _flow(fid, usd, date, status="paid", boundary="incoming"):
    return {"id": fid, "amountUSD": usd, "status": status, "date": f"{date}T00:00:00Z", "firstReportedDate": f"{date}T00:00:00Z",
            "boundary": boundary, "sourceObjects": [{"type": "Organization", "id": int(UK), "name": UK_NAME}],
            "destinationObjects": [{"type": "Plan", "id": int(SUDAN), "name": "Sudan Humanitarian Response Plan 2025"}]}


# 141,080,000 of commitments and payments dated before the deadline, plus a bare pledge and a late payment
FLOWS = [
    _flow(1001, 14_900_000, "2025-06-01"),
    _flow(1002, 93_430_000, "2025-11-20", status="commitment"),
    _flow(1003, 32_750_000, "2026-02-10"),
    _flow(1004, 5_000_000, "2025-04-15", status="pledge"),
    _flow(1005, 2_000_000, "2026-05-02"),
    _flow(1006, 9_000_000, "2025-08-01", boundary="outgoing"),
]
FUNDED = 141_080_000
PLAN = {"planVersion": {"name": "Sudan Humanitarian Response Plan 2025", "code": "HSDN25",
                        "startDate": "2025-01-01T00:00:00.000Z", "endDate": "2025-12-31T00:00:00.000Z"},
        "locations": [{"name": "Sudan"}]}
BODY = ("<h1>UK announces new humanitarian funding for Sudan</h1>"
        "<p>" + "The UK will provide 120 million pounds of life-saving humanitarian aid for people in Sudan this year. " * 4 + "</p>")
PAGE = ("<html><head><style>.x{}</style></head><body><div class='cookie-banner'>Cookies on GOV.UK</div><nav>Menu</nav>"
        f"<main id='main-content'>{BODY}<script>track()</script></main><footer>Footer</footer></body></html>")


FLOW_QUERY = f"{FTS}/fts/flow?planId={SUDAN}&filterBy=sourceOrganizationId:{UK}&limit=100"


def _flow_pages(direct_vm, flows, status=200, page_size=100, count=None, incoming_count=None, pages=None, statuses=None,
                counts=None, last_has_next=False):
    """Mock FTS's paged flow list: meta.count is the total, meta.nextLink is present on every page but the last.
    The keyword arguments let a test make the response inconsistent (wrong totals, a missing or failing page)."""
    chunks = pages if pages is not None else ([flows[i:i + page_size] for i in range(0, len(flows), page_size)] or [[]])
    total = len(flows) if count is None else count
    n_in = sum(1 for f in flows if f["boundary"] == "incoming") if incoming_count is None else incoming_count
    funded = sum(f["amountUSD"] for f in flows if f["boundary"] == "incoming" and f["status"] in ("paid", "commitment"))
    for i, chunk in enumerate(chunks, start=1):
        meta = {"language": "en", "count": (counts or {}).get(i, total)}
        if i < len(chunks) or last_has_next:
            meta["nextLink"] = f"{FLOW_QUERY}&page={i + 1}"
        _mock(direct_vm, f"{FLOW_QUERY}&page={i}", {"status": "ok", "meta": meta, "data": {
            "incoming": {"flowCount": n_in, "fundingTotal": funded}, "outgoing": {}, "internal": {}, "flows": chunk}},
            (statuses or {}).get(i, status))


def _setup(direct_vm, flows=None, flow_status=200, plan_status=200, donor_status=200, page_status=200, answer="MATCH", donor_flows=None,
           page=PAGE, fts=None):
    direct_vm.clear_mocks()
    flows = FLOWS if flows is None else flows
    _mock(direct_vm, f"{FTS}/fts/flow?organizationId={UK}&limit=1",
          {"status": "ok", "data": {"flows": [_flow(1001, 1, "2025-06-01")] if donor_flows is None else donor_flows}}, donor_status)
    _mock(direct_vm, f"{FTS}/plan/id/{SUDAN}", {"status": "ok", "data": PLAN} if plan_status == 200 else
          {"status": "notFound", "reason": "NotFoundError"}, plan_status)
    _flow_pages(direct_vm, flows, flow_status, **(fts or {}))
    _mock(direct_vm, URL, None, page_status, raw=page)
    direct_vm.mock_llm(r".*", json.dumps({"answer": answer}))


def _pledge(direct_vm, direct_deploy, pledger, payee, bond=4 * GEN, setup=None, **terms):
    direct_vm.sender = pledger
    contract = direct_deploy(CONTRACT_PATH)
    _setup(direct_vm, **(setup or {}))
    args = dict(donor_id=UK, plan_id=SUDAN, target_usd=TARGET, deadline=DEADLINE, announcement_url=URL, payout=4 * GEN,
                beneficiary=to_hex(payee), expires=_days_from_now(400))
    args.update(terms)
    direct_vm.value = bond
    result = contract.create_pledge(*args.values())
    direct_vm.value = 0
    return contract, result


def _file(direct_vm, contract, pledge_id, who, stake=None, **setup):
    _setup(direct_vm, **setup)
    direct_vm.sender = who
    direct_vm.value = int(contract.stake_for(pledge_id)) if stake is None else stake
    result = contract.file_claim(pledge_id)
    direct_vm.value = 0
    return result


def _expire(contract, claim_id):
    contract.claims[claim_id].window_from = "2000-01-01T00:00:00"


# --- pledges -----------------------------------------------------------------


def test_pledge_freezes_donor_plan_and_announcement(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    p = contract.get_pledge(pledge_id)
    assert (p.donor_id, p.donor_name, p.plan_id, int(p.target_usd), p.deadline) == (UK, UK_NAME, SUDAN, TARGET, DEADLINE)
    assert json.loads(p.plan_json) == {"name": "Sudan Humanitarian Response Plan 2025", "code": "HSDN25", "start": "2025-01-01",
                                       "end": "2025-12-31", "locations": ["Sudan"]}
    ann = json.loads(p.announcement_json)
    assert (ann["url"], ann["answer"]) == (URL, "MATCH")
    assert ann["excerpt"].startswith("UK announces new humanitarian funding for Sudan The UK will provide")
    assert not any(x in ann["excerpt"] for x in ("Cookies", "Menu", "track()", "Footer"))
    assert ann["sha256"] == _sha(ann["excerpt"]) and ann["chars"] == len(ann["excerpt"])
    assert contract.pledges_for_plan(SUDAN) == [pledge_id]
    assert contract.stake_for(pledge_id) == str(4 * GEN // 10)
    cov = json.loads(contract.coverage(pledge_id))
    assert (cov["claims_open"], cov["liability"], cov["covered"]) == ("2026-04-30", str(4 * GEN), True)


@pytest.mark.parametrize("terms, setup, reason", [
    (dict(donor_id="UK"), None, "donor_id must be an OCHA FTS organization id"),
    (dict(plan_id="HSDN25"), None, "plan_id must be an OCHA FTS plan id"),
    (dict(target_usd=999), None, "target_usd must be a whole number of dollars, at least 1000"),
    (dict(target_usd="1e8"), None, "target_usd must be a whole number"),
    (dict(deadline="March 2026"), None, "deadline must be a real calendar date written YYYY-MM-DD"),
    (dict(deadline="2026-02-31"), None, "deadline must be a real calendar date written YYYY-MM-DD"),
    (dict(expires="2027-13-01"), None, "expires must be a YYYY-MM-DD date"),
    (dict(announcement_url="http://gov.uk/x"), None, "announcement_url must be an https:// link"),
    (dict(payout=GEN // 2), None, "payout must be at least 1 GEN"),
    (dict(beneficiary="nope"), None, "beneficiary must be a wallet address"),
    (dict(deadline=_days_from_now(10), expires=_days_from_now(40)), None, f"and {_days_from_now(70)} or later"),
    (dict(payout=5 * GEN), None, "the bond must cover the payout"),
    ({}, dict(plan_status=404), "OCHA FTS has no plan with that id"),
    ({}, dict(donor_flows=[]), "OCHA FTS has no organization with that id"),
    ({}, dict(plan_status=503), "Could not read OCHA FTS right now"),
    ({}, dict(donor_status=500), "Could not read OCHA FTS right now"),
    ({}, dict(page_status=403), "Could not read the announcement right now"),
    ({}, dict(answer="NO_MATCH"), f"Validators did not read the announcement as a funding pledge from {UK_NAME} for this crisis (NO_MATCH)"),
    ({}, dict(answer="UNCLEAR"), "(UNCLEAR)"),
])
def test_invalid_pledges_are_refunded(direct_vm, direct_deploy, direct_alice, direct_bob, terms, setup, reason):
    contract, result = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, setup=setup, **terms)
    assert result.startswith("REFUNDED:") and reason in result
    assert contract.get_pledges(0, 10) == []


def test_pages_without_a_main_element_are_read_whole(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob,
                                  setup=dict(page=f"<html><body><nav>Menu</nav>{BODY}</body></html>"))
    assert json.loads(contract.get_pledge(pledge_id).announcement_json)["excerpt"].startswith("UK announces new humanitarian funding")
    _setup(direct_vm, page="<html><main>Short</main></html>")
    direct_vm.value = 4 * GEN
    result = contract.create_pledge(UK, SUDAN, TARGET, DEADLINE, URL, 4 * GEN, to_hex(direct_bob), _days_from_now(400))
    direct_vm.value = 0
    assert result.startswith("REFUNDED: Could not read the announcement")


def test_non_enum_announcement_answer_reverts(direct_vm, direct_deploy, direct_alice, direct_bob):
    with direct_vm.expect_revert("LLM answer must be one of"):
        _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, setup=dict(answer="PROBABLY"))


def test_only_the_pledger_adds_to_the_bond(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    direct_vm.sender, direct_vm.value = direct_bob, GEN
    assert contract.add_bond(pledge_id).startswith("REFUNDED: Only the pledger")
    direct_vm.sender = direct_alice
    assert contract.add_bond(pledge_id) == "added"
    direct_vm.value = 0
    assert int(contract.get_pledge(pledge_id).bond) == 5 * GEN


# --- rulings -------------------------------------------------------------------


def test_funding_short_of_target_is_a_breach(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie))
    facts = json.loads(claim.facts_json)
    assert (claim.verdict, claim.code) == ("BREACHED", "shortfall")
    assert (facts["funded_usd"], facts["flows_counted"], facts["after_deadline_usd"], facts["pledged_only_usd"]) == (FUNDED, 3, 2_000_000, 5_000_000)
    assert (facts["shortfall_usd"], facts["shortfall_bp"]) == (TARGET - FUNDED, 594)
    assert claim.why == (
        f"OCHA FTS records $141,080,000 of funding (commitments and payments) from {UK_NAME} to Sudan Humanitarian Response Plan 2025 "
        f"dated on or before {DEADLINE}, across 3 flows: $8,920,000 short of the pledged $150,000,000 (5.94% short). "
        "A further $2,000,000 is dated after the deadline and does not count.")


@pytest.mark.parametrize("target, verdict, code", [(140_000_000, "KEPT", "met"), (FUNDED, "KEPT", "met"), (FUNDED + 1, "BREACHED", "shortfall")])
def test_target_boundaries(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, target, verdict, code):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, target_usd=target)
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie))
    assert (claim.verdict, claim.code) == (verdict, code)


def test_no_flows_at_all_is_a_total_shortfall(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie, flows=[])
    facts = json.loads(contract.get_claim(claim_id).facts_json)
    assert (facts["funded_usd"], facts["shortfall_bp"]) == (0, 10000)
    _expire(contract, claim_id)
    assert contract.settle(claim_id) == "paid"
    last = json.loads(contract.get_claim(claim_id).timeline_json)[-1]
    assert (last["beneficiary"], last["reporter"]) == (str(36 * GEN // 10), str(4 * GEN // 10))
    assert int(contract.get_pledge(pledge_id).bond) == 0


@pytest.mark.parametrize("status", [503, 429, 404])
def test_fts_failures_decide_nothing(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, status):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie, flow_status=status))
    assert (claim.verdict, claim.code) == ("UNCLEAR", "unreachable")
    assert "proves nothing" in claim.why


# --- reading every FTS page --------------------------------------------------------


def _payments(contract, monkeypatch):
    """Record every GEN transfer the contract makes instead of sending it."""
    import sys

    sent = []

    class Recorder:
        def __init__(self, to):
            self.to = to

        def emit_transfer(self, value):
            sent.append((self.to.as_hex, int(value)))

    monkeypatch.setattr(sys.modules[type(contract).__module__], "_Wallet", Recorder)
    return sent


# 2,345 flows over 24 FTS pages of 100: 2,300 small payments before the deadline, plus pledges, late payments and
# outgoing flows that must not count. Page 1 alone holds only 100 of the qualifying payments.
MANY = ([_flow(10_000 + i, 50_000, "2025-07-01") for i in range(2_300)]
        + [_flow(20_000 + i, 1_000_000, "2025-07-01", status="pledge") for i in range(20)]
        + [_flow(30_000 + i, 1_000_000, "2026-05-01") for i in range(15)]
        + [_flow(40_000 + i, 1_000_000, "2025-07-01", boundary="outgoing") for i in range(10)])


@pytest.mark.parametrize("target, verdict", [(150_000_000, "BREACHED"), (100_000_000, "KEPT")])
def test_every_fts_page_is_read_and_every_qualifying_flow_counted(direct_vm, direct_deploy, direct_alice, direct_bob,
                                                                  direct_charlie, target, verdict):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, target_usd=target)
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie, flows=MANY))
    facts, packet = json.loads(claim.facts_json), json.loads(claim.evidence_json)[0]
    assert (facts["flows_reported"], facts["flows_read"], packet["pages_read"]) == (2_345, 2_345, 24)
    assert (facts["flows_counted"], facts["funded_usd"]) == (2_300, 115_000_000)  # page 1 alone would give 100 and $5M
    assert (facts["pledged_only_usd"], facts["after_deadline_usd"]) == (20_000_000, 15_000_000)
    assert claim.verdict == verdict  # a $100M target is met only because pages 2 to 24 were read
    if verdict == "BREACHED":
        assert facts["shortfall_usd"] == 35_000_000 and facts["shortfall_bp"] == 2333


@pytest.mark.parametrize("fts, code", [
    (dict(pages=[MANY[:100]], count=2_345), "incomplete"),  # FTS reports 2,345 flows but gives no next page
    (dict(statuses={2: 503}), "unreachable"),  # page 2 fails
    (dict(counts={13: 2_346}), "incomplete"),  # the total changed while paging
    (dict(incoming_count=2_400), "incomplete"),  # fewer incoming flows read than FTS reports
    (dict(pages=[MANY[:100], [], MANY[100:]]), "incomplete"),  # an empty page in the middle stops the read short
    (dict(pages=[[f] for f in MANY[:50]], count=51, last_has_next=True), "incomplete"),  # more than 50 pages
])
def test_an_incomplete_fts_reading_never_pays(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, monkeypatch, fts, code):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    sent = _payments(contract, monkeypatch)
    stake = int(contract.stake_for(pledge_id))
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie, flows=MANY, fts=fts)
    claim = contract.get_claim(claim_id)
    assert (claim.verdict, claim.code) == ("UNCLEAR", code)
    assert "the stake goes back" in claim.why
    _expire(contract, claim_id)
    assert contract.settle(claim_id) == "stake_returned"
    assert sent == [(to_hex(direct_charlie), stake)]  # only the reporter's stake moved: no payout on a partial count
    p = contract.get_pledge(pledge_id)
    assert (int(p.bond), int(p.total_paid)) == (4 * GEN, 0)


# --- filing --------------------------------------------------------------------


def test_filing_is_checked_and_refunded(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    assert "exactly 400000000000000000 wei" in _file(direct_vm, contract, pledge_id, direct_charlie, stake=GEN)
    assert "No pledge with id pledge_9" in _file(direct_vm, contract, "pledge_9", direct_charlie, stake=0)
    contract.pledges[pledge_id].deadline = _days_from_now(-10)
    assert f"Claims open on {_days_from_now(20)}" in _file(direct_vm, contract, pledge_id, direct_charlie)
    contract.pledges[pledge_id].deadline = DEADLINE
    contract.pledges[pledge_id].expires = "2026-06-01"
    assert "This pledge expired on 2026-06-01" in _file(direct_vm, contract, pledge_id, direct_charlie)
    assert contract.get_claims(0, 10) == []


def test_one_open_claim_at_a_time(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    first = _file(direct_vm, contract, pledge_id, direct_charlie)
    assert _file(direct_vm, contract, pledge_id, direct_bob) == f"REFUNDED: {first} is already open for this pledge"


# --- payout guarantees ----------------------------------------------------------


def test_partial_shortfall_pays_pro_rata_once(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie)
    stake = 4 * GEN // 10
    assert json.loads(contract.totals()) == {"bonds": str(4 * GEN), "pending_stakes": str(stake), "expected_balance": str(4 * GEN + stake)}
    _expire(contract, claim_id)
    assert contract.settle(claim_id) == "paid"
    amount = 4 * GEN * (TARGET - FUNDED) // TARGET
    last = json.loads(contract.get_claim(claim_id).timeline_json)[-1]
    assert (last["beneficiary"], last["reporter"], last["share_bp"]) == (str(amount - amount // 10), str(amount // 10), 594)
    p = contract.get_pledge(pledge_id)
    assert (int(p.bond), int(p.total_paid), p.outcome) == (4 * GEN - amount, amount, "paid")
    assert json.loads(contract.totals())["expected_balance"] == str(4 * GEN - amount)
    cov = json.loads(contract.coverage(pledge_id))
    assert (cov["liability"], cov["outcome"], cov["covered"]) == ("0", "paid", True)
    assert "already been ruled and settled (paid)" in _file(direct_vm, contract, pledge_id, direct_charlie)


def test_kept_pledge_keeps_the_stake_and_closes_claims(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, target_usd=140_000_000)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie)
    _expire(contract, claim_id)
    assert contract.settle(claim_id) == "stake_to_bond"
    p = contract.get_pledge(pledge_id)
    assert (int(p.bond), int(p.stakes_kept), p.outcome) == (4 * GEN + 4 * GEN // 10, 4 * GEN // 10, "kept")
    assert json.loads(contract.coverage(pledge_id))["liability"] == "0"
    assert "already been ruled and settled (kept)" in _file(direct_vm, contract, pledge_id, direct_charlie)


def test_unclear_returns_the_stake_and_can_be_refiled(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie, flow_status=502)
    _expire(contract, claim_id)
    assert contract.settle(claim_id) == "stake_returned"
    assert int(contract.get_pledge(pledge_id).bond) == 4 * GEN
    assert contract.get_pledge(pledge_id).outcome == ""
    assert _file(direct_vm, contract, pledge_id, direct_charlie).startswith("claim_")


# --- who may act, and when --------------------------------------------------------


def test_only_the_pledger_can_concede_early(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie)
    for who in (direct_charlie, direct_bob):
        direct_vm.sender = who
        with direct_vm.expect_revert("only the pledger can concede early"):
            contract.settle(claim_id)
    direct_vm.sender = direct_alice
    assert contract.settle(claim_id) == "paid"


def test_contests_reread_fts_and_each_side_contests_once(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie)
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Only the pledger can contest a shortfall"):
        contract.contest(claim_id)
    # a late report of a commitment dated before the deadline reaches FTS: the fresh reading meets the target
    _setup(direct_vm, flows=FLOWS + [_flow(1007, 9_000_000, "2026-03-30", status="commitment")])
    direct_vm.sender = direct_alice
    assert contract.contest(claim_id) == "KEPT"
    with direct_vm.expect_revert("Only the claimant can contest a ruling that pays nothing"):
        contract.contest(claim_id)
    _setup(direct_vm)
    direct_vm.sender = direct_charlie
    assert contract.contest(claim_id) == "BREACHED"
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("The pledger has already contested this claim"):
        contract.contest(claim_id)
    claim = contract.get_claim(claim_id)
    steps, packets = json.loads(claim.timeline_json), json.loads(claim.evidence_json)
    assert [s["event"] for s in steps] == ["filed", "contested", "contested"]
    assert [s["evidence"] for s in steps] == [p["packet_sha256"] for p in packets]


def test_window_closes_for_contests(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie)
    _expire(contract, claim_id)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("The response window has closed"):
        contract.contest(claim_id)


def test_bond_is_locked_until_expiry_and_open_claims(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, target_usd=140_000_000)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Only the pledger can withdraw the bond"):
        contract.withdraw(pledge_id)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("The bond stays until the pledge expires"):
        contract.withdraw(pledge_id)
    contract.pledges[pledge_id].expires = "2026-06-01"
    with direct_vm.expect_revert("Settle the open claims first"):
        contract.withdraw(pledge_id)
    _expire(contract, claim_id)
    contract.settle(claim_id)
    assert contract.withdraw(pledge_id) == str(4 * GEN + 4 * GEN // 10)
    assert contract.pledges_for_plan(SUDAN) == []
    assert json.loads(contract.totals())["expected_balance"] == "0"
    with direct_vm.expect_revert("already been withdrawn"):
        contract.withdraw(pledge_id)


# --- evidence --------------------------------------------------------------------


def test_every_reading_keeps_an_evidence_packet(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie))
    packet = json.loads(claim.evidence_json)[0]
    assert packet["source"] == FLOW_QUERY
    assert packet["record"] == f"https://fts.unocha.org/plans/{SUDAN}/summary"
    assert (packet["flows_total"], packet["fts_total_incoming"], packet["pages_read"]) == (5, FUNDED + 2_000_000, 1)
    assert [f["id"] for f in packet["flows"]] == ["1004", "1001", "1002", "1003", "1005"]  # by date; the outgoing flow is left out
    assert packet["flows"][1] == {"id": "1001", "status": "paid", "date": "2025-06-01", "usd": 14_900_000, "reported": "2025-06-01"}
    assert packet["flows_sha256"] == _sha(json.dumps(packet["flows"], sort_keys=True))
    body = {k: v for k, v in packet.items() if k != "packet_sha256"}
    assert packet["packet_sha256"] == _sha(json.dumps(body, sort_keys=True))
    assert json.loads(claim.timeline_json)[0]["evidence"] == packet["packet_sha256"]


def test_registry_reads_in_one_call(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie)
    assert [p.id for p in contract.get_pledges(0, 200)] == [pledge_id]
    assert [c.id for c in contract.get_claims(0, 200)] == [claim_id]
    assert contract.explain_claim(claim_id).startswith("BREACHED: OCHA FTS records $141,080,000")
    assert contract.response_window_seconds() == 600
