"""Direct-mode tests for the AidPledge contract (v2: OCHA FTS plus the donor's own IATI reports, deposit-funded bonds
and stakes, pull payments)."""

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone

import pytest

from tests.direct.conftest import CONTRACT_PATH, llm_json, to_hex

GEN = 10**18
FTS = "https://api.hpc.tools/v1/public"
IATI = "https://d-portal.org/q.json"
UK, SUDAN = "2917", "1220"
UK_NAME = "United Kingdom, Government of"
FCDO, FCDO_NAME = "GB-GOV-1", "UK - Foreign, Commonwealth Development Office (FCDO)"
URL = "https://www.gov.uk/government/news/uk-announces-new-humanitarian-funding-for-sudan"
DEADLINE = "2026-03-31"
TARGET = 150_000_000
BOND = 4 * GEN
STAKE = BOND // 10


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
        "locations": [{"name": "Sudan", "iso3": "SDN", "pcode": "SD", "adminLevel": 0}]}
BODY = ("<h1>UK announces new humanitarian funding for Sudan</h1>"
        "<p>" + "The UK will provide 120 million pounds of life-saving humanitarian aid for people in Sudan this year. " * 4 + "</p>")
PAGE = ("<html><head><style>.x{}</style></head><body><div class='cookie-banner'>Cookies on GOV.UK</div><nav>Menu</nav>"
        f"<main id='main-content'>{BODY}<script>track()</script></main><footer>Footer</footer></body></html>")

FLOW_QUERY = f"{FTS}/fts/flow?planId={SUDAN}&filterBy=sourceOrganizationId:{UK}&limit=100"
PUBLISHER_QUERY = f"{IATI}?select=reporting,count_aid&from=act&reporting_ref={FCDO}&groupby=reporting"
MOVED_QUERY = (f"{IATI}?select=sum_of_percent_of_trans_usd,count_aid&from=act,trans,country,sector&reporting_ref={FCDO}"
               f"&country_code=SD&trans_code=D|E&sector_group=720|730|740&trans_day_gteq=2025-01-01&trans_day_lteq={DEADLINE}")
IATI_USD = 120_000_000.4  # d-portal sums shares of transactions as floats


def _flow_pages(direct_vm, flows, status=200, page_size=100, count=None, incoming_count=None, pages=None, statuses=None,
                counts=None, last_has_next=False):
    """Mock FTS's paged flow list: meta.count is the total, meta.nextLink is present on every page but the last.
    The keyword arguments let a test make the response inconsistent (wrong totals, a missing or failing page)."""
    chunks = pages if pages is not None else ([flows[i:i + page_size] for i in range(0, len(flows), page_size)] or [[]])
    total = len(flows) if count is None else count
    n_in = sum(1 for f in flows if f["boundary"] == "incoming") if incoming_count is None else incoming_count
    for i, chunk in enumerate(chunks, start=1):
        meta = {"language": "en", "count": (counts or {}).get(i, total)}
        if i < len(chunks) or last_has_next:
            meta["nextLink"] = f"{FLOW_QUERY}&page={i + 1}"
        _mock(direct_vm, f"{FLOW_QUERY}&page={i}", {"status": "ok", "meta": meta, "data": {
            "incoming": {"flowCount": n_in}, "outgoing": {}, "internal": {}, "flows": chunk}}, (statuses or {}).get(i, status))


def _setup(direct_vm, flows=None, flow_status=200, plan=None, plan_status=200, donor_status=200, page_status=200, answer="MATCH",
           publisher="SAME", donor_flows=None, page=PAGE, fts=None, iati_usd=IATI_USD, iati_status=200, iati_rows=None,
           publisher_rows=None, publisher_status=200):
    direct_vm.clear_mocks()
    flows = FLOWS if flows is None else flows
    _mock(direct_vm, f"{FTS}/fts/flow?organizationId={UK}&limit=1",
          {"status": "ok", "data": {"flows": [_flow(1001, 1, "2025-06-01")] if donor_flows is None else donor_flows}}, donor_status)
    _mock(direct_vm, f"{FTS}/plan/id/{SUDAN}", {"status": "ok", "data": plan or PLAN} if plan_status == 200 else
          {"status": "notFound", "reason": "NotFoundError"}, plan_status)
    _flow_pages(direct_vm, flows, flow_status, **(fts or {}))
    _mock(direct_vm, URL, None, page_status, raw=page)
    _mock(direct_vm, PUBLISHER_QUERY, {"rows": publisher_rows if publisher_rows is not None else [
        {"reporting": "UK - Foreign, Commonwealth and Development Office", "count_aid": "3239"},
        {"reporting": FCDO_NAME, "count_aid": "22232"}], "count": 2}, publisher_status)
    _mock(direct_vm, MOVED_QUERY, {"rows": iati_rows if iati_rows is not None else
                                   [{"sum_of_percent_of_trans_usd": iati_usd, "count_aid": "14"}], "count": 1}, iati_status)
    direct_vm.mock_llm(r".*", llm_json({"answer": answer, "publisher": publisher}))


def _deposit(direct_vm, contract, who, amount):
    if amount:
        direct_vm.sender, direct_vm.value = who, amount
        contract.deposit()
        direct_vm.value = 0


def _pledge(direct_vm, direct_deploy, pledger, payee, bond=BOND, deposit=None, setup=None, expect=None, iati=FCDO, **terms):
    direct_vm.sender = pledger
    contract = direct_deploy(CONTRACT_PATH)
    _setup(direct_vm, **(setup or {}))
    _deposit(direct_vm, contract, pledger, bond if deposit is None else deposit)
    args = dict(donor_id=UK, plan_id=SUDAN, target_usd=TARGET, deadline=DEADLINE, announcement_url=URL, payout=4 * GEN,
                beneficiary=to_hex(payee), expires=_days_from_now(400), iati_ref=iati, bond=bond)
    args.update(terms)
    direct_vm.sender = pledger
    if expect:
        with direct_vm.expect_revert(expect):
            contract.create_pledge(*args.values())
        return contract, None
    return contract, contract.create_pledge(*args.values())


def _file(direct_vm, contract, pledge_id, who, deposit=STAKE, expect=None, **setup):
    _setup(direct_vm, **setup)
    _deposit(direct_vm, contract, who, deposit)
    direct_vm.sender = who
    if expect:
        with direct_vm.expect_revert(expect):
            contract.file_claim(pledge_id)
        return None
    return contract.file_claim(pledge_id)


def _expire(contract, claim_id):
    contract.claims[claim_id].window_from = "2000-01-01T00:00:00"


def _owed(contract, who):
    return int(contract.owed_to(to_hex(who).lower()))


def _payments(contract, monkeypatch):
    """Record every GEN transfer the contract makes (only `withdraw` sends any) instead of sending it."""
    import sys

    sent = []
    monkeypatch.setattr(sys.modules[type(contract).__module__], "_send", lambda to, amount: sent.append((to.as_hex, int(amount))))
    return sent


def _balanced(contract):
    """Running totals equal the sums they stand for (what the contract must hold)."""
    t = json.loads(contract.totals())
    bonds = sum(int(p.bond) for p in contract.get_pledges(0, 200) if p.state == "active")
    stakes = sum(int(c.stake) for c in contract.get_claims(0, 200) if c.state == "pending")
    assert (int(t["bonds"]), int(t["pending_stakes"])) == (bonds, stakes)
    assert int(t["expected_balance"]) == bonds + stakes + int(t["owed"])
    return t


# --- pledges -----------------------------------------------------------------


def test_pledge_freezes_donor_plan_publisher_and_announcement(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    p = contract.get_pledge(pledge_id)
    assert (p.donor_id, p.donor_name, p.plan_id, int(p.target_usd), p.deadline) == (UK, UK_NAME, SUDAN, TARGET, DEADLINE)
    assert (p.iati_ref, p.iati_name, p.iati_country) == (FCDO, FCDO_NAME, "SD")  # the publisher's name on most activities
    assert json.loads(p.plan_json) == {"name": "Sudan Humanitarian Response Plan 2025", "code": "HSDN25", "start": "2025-01-01",
                                       "end": "2025-12-31", "locations": ["Sudan"], "countries": ["SD"]}
    ann = json.loads(p.announcement_json)
    assert (ann["url"], ann["answer"]) == (URL, "MATCH")
    assert ann["excerpt"].startswith("UK announces new humanitarian funding for Sudan The UK will provide")
    assert not any(x in ann["excerpt"] for x in ("Cookies", "Menu", "track()", "Footer"))
    assert ann["sha256"] == _sha(ann["excerpt"]) and ann["chars"] == len(ann["excerpt"])
    assert (int(p.bond), int(p.total_bonded), _owed(contract, direct_alice)) == (BOND, BOND, 0)  # the deposit became the bond
    assert contract.stake_for(pledge_id) == str(STAKE)
    cov = json.loads(contract.coverage(pledge_id))
    assert (cov["claims_open"], cov["liability"], cov["covered"], cov["iati"]) == ("2026-04-30", str(4 * GEN), True, FCDO)
    _balanced(contract)


@pytest.mark.parametrize("terms, setup, reason", [
    (dict(donor_id="UK"), None, "donor_id must be an OCHA FTS organization id"),
    (dict(plan_id="HSDN25"), None, "plan_id must be an OCHA FTS plan id"),
    (dict(iati_ref="GB GOV 1"), None, "iati_ref must be an IATI organisation identifier"),
    (dict(target_usd=999), None, "target_usd must be at least 1000 dollars"),
    (dict(target_usd="1e8"), None, "target_usd must be a whole number"),
    (dict(bond=-1, deposit=BOND), None, "bond must be a whole number"),
    (dict(deadline="March 2026"), None, "deadline must be a real calendar date written YYYY-MM-DD"),
    (dict(deadline="2026-02-31"), None, "deadline must be a real calendar date written YYYY-MM-DD"),
    (dict(expires="2027-13-01"), None, "expires must be a real YYYY-MM-DD date"),
    (dict(announcement_url="http://gov.uk/x"), None, "announcement_url must be an https:// link"),
    (dict(payout=GEN // 2), None, "payout must be at least 1 GEN"),
    (dict(beneficiary="nope"), None, "beneficiary must be a wallet address"),
    (dict(deadline=_days_from_now(10), expires=_days_from_now(40)), None, f"and {_days_from_now(70)} or later"),
    (dict(payout=5 * GEN), None, "the bond must cover the payout"),
    (dict(bond=5 * GEN, payout=5 * GEN, deposit=BOND), None, "deposit first: 5 GEN needed, 4 GEN credited"),
    ({}, dict(plan_status=404), "OCHA FTS has no plan with that id"),
    ({}, dict(donor_flows=[]), "OCHA FTS has no organization with that id"),
    ({}, dict(plan_status=503), "Could not read OCHA FTS right now"),
    ({}, dict(donor_status=500), "Could not read OCHA FTS right now"),
    ({}, dict(page_status=403), "Could not read the announcement right now"),
    ({}, dict(publisher_rows=[]), "IATI has no publisher with that id"),
    ({}, dict(publisher_status=502), "Could not read IATI (d-portal) right now"),
    ({}, dict(plan={**PLAN, "locations": PLAN["locations"] + [{"name": "Chad", "pcode": "TD", "adminLevel": 0}]}),
     "The IATI check needs a plan for a single country"),
    ({}, dict(answer="NO_MATCH"), f"Validators did not read the announcement as a funding pledge from {UK_NAME} for this crisis (NO_MATCH)"),
    ({}, dict(answer="UNCLEAR"), "(UNCLEAR)"),
    ({}, dict(publisher="OTHER"), f"Validators did not read IATI publisher {FCDO} ({FCDO_NAME}) as {UK_NAME}"),
])
def test_invalid_pledges_are_refused_and_take_nothing(direct_vm, direct_deploy, direct_alice, direct_bob, terms, setup, reason):
    contract, _ = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, setup=setup, expect=reason, **terms)
    assert contract.get_pledges(0, 10) == []
    assert _owed(contract, direct_alice) == BOND  # nothing was taken: the deposit can be withdrawn
    _balanced(contract)


def test_create_pledge_and_file_claim_carry_no_gen(direct_vm, direct_deploy, direct_alice, direct_bob):
    """GEN never rides on a call that needs the validators to agree: those two methods are not payable."""
    source = open(CONTRACT_PATH).read()
    for method in ("create_pledge", "file_claim", "contest", "settle", "release_bond", "withdraw"):
        decorator = re.search(rf"@gl\.public\.write(\.payable)?\s*\n\s*def {method}\(", source)
        assert decorator and decorator.group(1) is None, method
    assert re.search(r"@gl\.public\.write\.payable\s*\n\s*def deposit\(", source)


def test_a_pledge_without_iati_is_ruled_on_fts_alone(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, iati="",
                                  setup=dict(publisher_status=500, plan={**PLAN, "locations": PLAN["locations"] * 2}))
    p = contract.get_pledge(pledge_id)
    assert (p.iati_ref, p.iati_name, p.iati_country) == ("", "", "")
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie, iati_status=500))
    assert (claim.verdict, claim.code) == ("BREACHED", "shortfall")
    assert "iati_usd" not in json.loads(claim.facts_json) and "iati_source" not in json.loads(claim.evidence_json)[0]
    assert claim.why == (
        f"OCHA FTS records $141,080,000 of funding (commitments and payments) from {UK_NAME} to Sudan Humanitarian Response Plan 2025 "
        f"dated on or before {DEADLINE}, across 3 flows: $8,920,000 short of the pledged $150,000,000 (5.94% short). "
        "A further $2,000,000 on FTS is dated after the deadline and does not count.")


def test_pages_without_a_main_element_are_read_whole(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob,
                                  setup=dict(page=f"<html><body><nav>Menu</nav>{BODY}</body></html>"))
    assert json.loads(contract.get_pledge(pledge_id).announcement_json)["excerpt"].startswith("UK announces new humanitarian funding")
    _setup(direct_vm, page="<html><main>Short</main></html>")
    _deposit(direct_vm, contract, direct_alice, BOND)
    with direct_vm.expect_revert("Could not read the announcement"):
        contract.create_pledge(UK, SUDAN, TARGET, DEADLINE, URL, 4 * GEN, to_hex(direct_bob), _days_from_now(400), FCDO, BOND)


def test_non_enum_announcement_answer_reverts(direct_vm, direct_deploy, direct_alice, direct_bob):
    _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, setup=dict(answer="PROBABLY"), expect="LLM answer must be one of")


def test_only_the_pledger_adds_to_the_bond(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    direct_vm.sender, direct_vm.value = direct_bob, GEN
    assert contract.add_bond(pledge_id).startswith("REFUNDED: Only the pledger")
    assert _owed(contract, direct_bob) == GEN  # credited back, not lost
    direct_vm.sender = direct_alice
    assert contract.add_bond(pledge_id) == "added"
    direct_vm.value = 0
    assert int(contract.get_pledge(pledge_id).bond) == 5 * GEN
    _balanced(contract)


# --- rulings on FTS ------------------------------------------------------------


def test_funding_short_on_both_sources_is_a_breach(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie))
    facts = json.loads(claim.facts_json)
    assert (claim.verdict, claim.code) == ("BREACHED", "shortfall")
    assert (facts["funded_usd"], facts["flows_counted"], facts["after_deadline_usd"], facts["pledged_only_usd"]) == (FUNDED, 3, 2_000_000, 5_000_000)
    assert (facts["iati_usd"], facts["iati_activities"], facts["iati_from"], facts["iati_country"]) == (120_000_000, 14, "2025-01-01", "SD")
    assert (facts["shortfall_usd"], facts["shortfall_bp"]) == (TARGET - FUNDED, 594)  # FTS shows more: the smaller gap counts
    assert claim.why == (
        f"OCHA FTS records $141,080,000 of funding (commitments and payments) from {UK_NAME} to Sudan Humanitarian Response Plan 2025 "
        f"dated on or before {DEADLINE}, across 3 flows, and {UK_NAME}'s own IATI reports ({FCDO_NAME}) show $120,000,000 of "
        f"humanitarian disbursements to SD from 2025-01-01 to {DEADLINE}, across 14 activities. Even the larger of the two, "
        "$141,080,000, is $8,920,000 short of the pledged $150,000,000 (5.94% short). "
        "A further $2,000,000 on FTS is dated after the deadline and does not count.")


@pytest.mark.parametrize("target, verdict, code", [(140_000_000, "KEPT", "met"), (FUNDED, "KEPT", "met"), (FUNDED + 1, "BREACHED", "shortfall")])
def test_target_boundaries(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, target, verdict, code):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, target_usd=target)
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie))
    assert (claim.verdict, claim.code) == (verdict, code)


def test_a_met_pledge_does_not_need_iati(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, target_usd=140_000_000)
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie, iati_status=503))
    assert (claim.verdict, claim.code) == ("KEPT", "met")


def test_no_flows_and_no_iati_spending_is_a_total_shortfall(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie, flows=[],
                     iati_rows=[{"sum_of_percent_of_trans_usd": None, "count_aid": "0"}])
    facts = json.loads(contract.get_claim(claim_id).facts_json)
    assert (facts["funded_usd"], facts["iati_usd"], facts["shortfall_bp"]) == (0, 0, 10000)
    _expire(contract, claim_id)
    assert contract.settle(claim_id) == "paid"
    last = json.loads(contract.get_claim(claim_id).timeline_json)[-1]
    assert (last["beneficiary"], last["reporter"]) == (str(36 * GEN // 10), str(4 * GEN // 10))
    assert int(contract.get_pledge(pledge_id).bond) == 0
    assert (_owed(contract, direct_bob), _owed(contract, direct_charlie)) == (36 * GEN // 10, 4 * GEN // 10 + STAKE)
    _balanced(contract)


@pytest.mark.parametrize("status", [503, 429, 404])
def test_fts_failures_decide_nothing(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, status):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie, flow_status=status))
    assert (claim.verdict, claim.code) == ("UNCLEAR", "unreachable")
    assert "proves nothing" in claim.why


# --- the second source: the donor's own IATI reports ---------------------------------


def test_donor_reports_covering_the_pledge_mean_no_payout(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    """FTS shows a shortfall, but the donor's own IATI reports show the pledge was spent: the sources disagree."""
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie, iati_usd=160_709_746.93)
    claim = contract.get_claim(claim_id)
    facts = json.loads(claim.facts_json)
    assert (claim.verdict, claim.code, facts["funded_usd"], facts["iati_usd"]) == ("UNCLEAR", "sources_disagree", FUNDED, 160_709_747)
    assert "the two sources disagree, so nothing is paid and the stake goes back" in claim.why
    assert json.loads(claim.evidence_json)[0]["iati_source"] == MOVED_QUERY
    _expire(contract, claim_id)
    assert contract.settle(claim_id) == "stake_returned"
    p = contract.get_pledge(pledge_id)
    assert (int(p.bond), int(p.total_paid), p.outcome) == (BOND, 0, "")
    assert (_owed(contract, direct_charlie), _owed(contract, direct_bob)) == (STAKE, 0)


@pytest.mark.parametrize("iati_usd, shortfall, bp", [
    (TARGET, None, None),  # exactly the target: covered
    (TARGET - 1, 1, 0),  # IATI above FTS: only the gap both sources show is paid
    (145_000_000, 5_000_000, 333),
    (0, TARGET - FUNDED, 594),  # nothing on IATI: FTS's (smaller) gap still counts
])
def test_the_gap_both_sources_show_is_paid(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, iati_usd, shortfall, bp):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie, iati_usd=iati_usd)
    claim = contract.get_claim(claim_id)
    if shortfall is None:
        assert claim.code == "sources_disagree"
        return
    facts = json.loads(claim.facts_json)
    assert (claim.verdict, facts["shortfall_usd"], facts["shortfall_bp"]) == ("BREACHED", shortfall, bp)
    _expire(contract, claim_id)
    contract.settle(claim_id)
    assert int(contract.get_pledge(pledge_id).total_paid) == max(4 * GEN * shortfall // TARGET, 1)


@pytest.mark.parametrize("setup", [dict(iati_status=503), dict(iati_status=404), dict(iati_rows=[]),
                                   dict(iati_rows=[{"a": 1}, {"b": 2}])])
def test_an_unreadable_iati_reading_never_pays(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, setup):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie, **setup))
    assert (claim.verdict, claim.code) == ("UNCLEAR", "iati_unreachable")
    assert "could not be read to confirm it; the stake goes back" in claim.why


def test_the_iati_window_runs_from_the_plan_start_to_the_deadline(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    plan = {**PLAN, "planVersion": {**PLAN["planVersion"], "startDate": None}}  # no start date: the deadline's year
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, setup=dict(plan=plan))
    _setup(direct_vm, iati_usd=1.0)
    query = MOVED_QUERY.replace("trans_day_gteq=2025-01-01", "trans_day_gteq=2026-01-01")
    _mock(direct_vm, query, {"rows": [{"sum_of_percent_of_trans_usd": 155_000_000, "count_aid": "9"}]})
    _deposit(direct_vm, contract, direct_charlie, STAKE)
    direct_vm.sender = direct_charlie
    claim = contract.get_claim(contract.file_claim(pledge_id))
    assert (claim.code, json.loads(claim.facts_json)["iati_from"]) == ("sources_disagree", "2026-01-01")


# --- reading every FTS page --------------------------------------------------------

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
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie, flows=MANY, iati_usd=0))
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
def test_an_incomplete_fts_reading_never_pays(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, fts, code):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie, flows=MANY, fts=fts, iati_usd=0)
    claim = contract.get_claim(claim_id)
    assert (claim.verdict, claim.code) == ("UNCLEAR", code)
    assert "the stake goes back" in claim.why
    _expire(contract, claim_id)
    assert contract.settle(claim_id) == "stake_returned"
    assert _owed(contract, direct_charlie) == STAKE  # only the reporter's stake moved: no payout on a partial count
    p = contract.get_pledge(pledge_id)
    assert (int(p.bond), int(p.total_paid)) == (BOND, 0)


# --- filing --------------------------------------------------------------------


def test_filing_is_checked_and_takes_nothing_when_refused(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    _file(direct_vm, contract, pledge_id, direct_charlie, deposit=STAKE - 1, expect="deposit first: 0.4 GEN needed, 0.4 GEN credited")
    _file(direct_vm, contract, "pledge_9", direct_charlie, deposit=0, expect="No pledge with id pledge_9")
    contract.pledges[pledge_id].deadline = _days_from_now(-10)
    _file(direct_vm, contract, pledge_id, direct_charlie, deposit=0, expect=f"Claims open on {_days_from_now(20)}")
    contract.pledges[pledge_id].deadline = DEADLINE
    contract.pledges[pledge_id].expires = "2026-06-01"
    _file(direct_vm, contract, pledge_id, direct_charlie, deposit=0, expect="This pledge expired on 2026-06-01")
    assert contract.get_claims(0, 10) == []
    assert _owed(contract, direct_charlie) == STAKE - 1


def test_one_open_claim_at_a_time(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    first = _file(direct_vm, contract, pledge_id, direct_charlie)
    assert _owed(contract, direct_charlie) == 0  # the stake left the deposit when the claim was filed
    _file(direct_vm, contract, pledge_id, direct_bob, expect=f"{first} is already open for this pledge")
    assert _owed(contract, direct_bob) == STAKE


# --- payout guarantees ----------------------------------------------------------


def test_partial_shortfall_pays_pro_rata_once(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie)
    t = _balanced(contract)
    assert (t["bonds"], t["pending_stakes"], t["owed"], t["expected_balance"]) == (str(BOND), str(STAKE), "0", str(BOND + STAKE))
    _expire(contract, claim_id)
    assert contract.settle(claim_id) == "paid"
    amount = 4 * GEN * (TARGET - FUNDED) // TARGET
    last = json.loads(contract.get_claim(claim_id).timeline_json)[-1]
    assert (last["beneficiary"], last["reporter"], last["share_bp"]) == (str(amount - amount // 10), str(amount // 10), 594)
    p = contract.get_pledge(pledge_id)
    assert (int(p.bond), int(p.total_paid), p.outcome) == (BOND - amount, amount, "paid")
    assert (_owed(contract, direct_bob), _owed(contract, direct_charlie)) == (amount - amount // 10, amount // 10 + STAKE)
    assert json.loads(contract.totals())["expected_balance"] == str(BOND + STAKE)  # nothing has left yet: all credited
    cov = json.loads(contract.coverage(pledge_id))
    assert (cov["liability"], cov["outcome"], cov["covered"]) == ("0", "paid", True)
    _file(direct_vm, contract, pledge_id, direct_charlie, expect="already been ruled and settled (paid)")
    _balanced(contract)


def test_kept_pledge_keeps_the_stake_and_closes_claims(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, target_usd=140_000_000)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie)
    _expire(contract, claim_id)
    assert contract.settle(claim_id) == "stake_to_bond"
    p = contract.get_pledge(pledge_id)
    assert (int(p.bond), int(p.stakes_kept), p.outcome) == (BOND + STAKE, STAKE, "kept")
    assert json.loads(contract.coverage(pledge_id))["liability"] == "0"
    _file(direct_vm, contract, pledge_id, direct_charlie, expect="already been ruled and settled (kept)")
    _balanced(contract)


def test_unclear_returns_the_stake_and_can_be_refiled(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie, flow_status=502)
    _expire(contract, claim_id)
    assert contract.settle(claim_id) == "stake_returned"
    assert (int(contract.get_pledge(pledge_id).bond), contract.get_pledge(pledge_id).outcome) == (BOND, "")
    assert _owed(contract, direct_charlie) == STAKE
    assert _file(direct_vm, contract, pledge_id, direct_charlie, deposit=0).startswith("claim_")  # refiled from the credit


# --- money leaves only through withdraw ----------------------------------------------


def test_deposit_and_withdraw(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, monkeypatch):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob, deposit=BOND + GEN)
    sent = _payments(contract, monkeypatch)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("send some GEN to deposit"):
        contract.deposit()
    assert contract.withdraw() == str(GEN)  # the unused part of the deposit
    with direct_vm.expect_revert("Nothing to withdraw"):
        contract.withdraw()
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie, flows=[], iati_rows=[{"sum_of_percent_of_trans_usd": 0, "count_aid": "0"}])
    _expire(contract, claim_id)
    direct_vm.sender = direct_bob
    contract.settle(claim_id)
    assert sent == [(to_hex(direct_alice), GEN)]  # settling credited the payout; nothing was sent
    assert contract.withdraw() == str(36 * GEN // 10)
    direct_vm.sender = direct_charlie
    contract.withdraw()
    assert sent[1:] == [(to_hex(direct_bob), 36 * GEN // 10), (to_hex(direct_charlie), 4 * GEN // 10 + STAKE)]
    t = _balanced(contract)
    assert (t["expected_balance"], t["withdrawn"]) == ("0", str(GEN + 4 * GEN + STAKE))


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


def test_only_the_claimant_can_accept_a_no_payout_ruling_early(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie, iati_usd=TARGET)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("only the claimant can accept early"):
        contract.settle(claim_id)
    direct_vm.sender = direct_charlie
    assert contract.settle(claim_id) == "stake_returned"


def test_contests_reread_both_sources_and_each_side_contests_once(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim_id = _file(direct_vm, contract, pledge_id, direct_charlie)
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Only the pledger can contest a shortfall"):
        contract.contest(claim_id)
    # the donor's IATI file is updated with this quarter's disbursements: its own reports now cover the pledge
    _setup(direct_vm, iati_usd=151_000_000)
    direct_vm.sender = direct_alice
    assert contract.contest(claim_id) == "UNCLEAR"
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
    assert [s.get("verdict") for s in steps] == ["BREACHED", "UNCLEAR", "BREACHED"]
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
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("The bond stays until the pledge expires"):
        contract.release_bond(pledge_id)
    contract.pledges[pledge_id].expires = "2026-06-01"
    with direct_vm.expect_revert("Settle the open claims first"):
        contract.release_bond(pledge_id)
    _expire(contract, claim_id)
    contract.settle(claim_id)
    direct_vm.sender = direct_bob  # anyone may release an expired bond: it is credited to the pledger only
    assert contract.release_bond(pledge_id) == str(BOND + STAKE)
    assert (_owed(contract, direct_alice), _owed(contract, direct_bob)) == (BOND + STAKE, 0)
    t = _balanced(contract)
    assert (t["bonds"], t["expected_balance"]) == ("0", str(BOND + STAKE))
    with direct_vm.expect_revert("already been released"):
        contract.release_bond(pledge_id)


# --- evidence and scale --------------------------------------------------------------


def test_every_reading_keeps_an_evidence_packet(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract, pledge_id = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    claim = contract.get_claim(_file(direct_vm, contract, pledge_id, direct_charlie))
    packet = json.loads(claim.evidence_json)[0]
    assert (packet["source"], packet["iati_source"]) == (FLOW_QUERY, MOVED_QUERY)
    assert packet["record"] == f"https://fts.unocha.org/plans/{SUDAN}/summary"
    assert (packet["flows_total"], packet["pages_read"]) == (5, 1)
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


def test_running_totals_stay_exact_over_many_pledges_and_claims(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    """totals() reads four numbers whatever the size of the registry; they match the sums after every kind of event."""
    contract, first = _pledge(direct_vm, direct_deploy, direct_alice, direct_bob)
    ids = [first]
    for i, target in enumerate([140_000_000, TARGET, 200_000_000, TARGET, TARGET]):
        _deposit(direct_vm, contract, direct_alice, BOND)
        direct_vm.sender = direct_alice
        ids.append(contract.create_pledge(UK, SUDAN, target, DEADLINE, URL, 4 * GEN, to_hex(direct_bob), _days_from_now(400), FCDO, BOND))
    claims = []
    for pid, iati in zip(ids, [0, 0, TARGET, 0, 1.0, 0]):
        claims.append(_file(direct_vm, contract, pid, direct_charlie, iati_usd=iati))
        _balanced(contract)
    for cid in claims[:4]:
        _expire(contract, cid)
        contract.settle(cid)
        _balanced(contract)
    direct_vm.sender = direct_bob
    contract.withdraw()
    assert _owed(contract, direct_bob) == 0
    assert int(_balanced(contract)["withdrawn"]) > 0
