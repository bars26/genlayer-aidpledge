# AidPledge

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/license/mit/)

<img src="assets/aidpledge-logo.png" alt="AidPledge logo" width="96" align="right" />

**Humanitarian funding pledges, backed by GEN and checked by GenLayer validators against the UN's own funding records
and the donor's own IATI reports.** Runs on GenLayer Studio and on Bradbury testnet, from one source.

Donor governments announce aid at pledging conferences: "£120 million for Sudan", "€100 million for Yemen". Months
later, few people check how much of it was actually committed or paid, and nothing happens when a pledge falls short.
The UN does keep the scoreboard: OCHA's [Financial Tracking Service](https://fts.unocha.org) (FTS) records every
reported flow of humanitarian money, by donor, by response plan, by date and by status (pledged, committed, paid).

AidPledge puts money behind an announced pledge:

1. A **pledger** (the donor itself, or anyone backing a donor's public pledge with their own GEN) names a **donor**
   (FTS organization id), a **response plan** (FTS plan id), a **target** in US dollars and a **deadline**, and cites
   the donor's **public announcement**, and optionally the donor's **IATI publisher id** (for example `GB-GOV-1`, the
   UK's FCDO) as a second source. Validators read the donor and the plan from FTS and freeze them. They also
   fetch the announcement (only the page's `<main>` content) and answer one question: is this the donor's funding
   pledge for the crisis this plan responds to? With an IATI publisher, they also confirm it is this donor (or one of its
   ministries). Anything else refuses the pledge. The bond (taken from the pledger's deposit, only after the validators
   agree) must cover the payout, and the pledge runs at least 60 days past the deadline.
2. **30 days after the deadline** (donors report to FTS late), **anyone reports** a shortfall by staking 10% of the
   payout (from their deposit).
3. **Every validator** reads every incoming flow from the donor to the plan on FTS and decides **in code**: flows with
   status *commitment* or *paid*, dated on or before the deadline, count. Bare pledges and flows dated later are shown
   but never counted. Counted funding ≥ target: **delivered**. Below, and the pledge names an IATI publisher: validators
   also read, through [d-portal](https://d-portal.org), the humanitarian disbursements the donor itself published to
   IATI for the plan's country from the plan's start to the deadline. If those cover the target, the two sources
   **disagree** and nothing is paid; otherwise the pledge **fell short** by the gap both sources show (the smaller one).
4. The side the ruling goes against may ask **once** for a fresh reading within 10 minutes (a late report may have
   reached FTS). Every ruling stores a **plain-English reason**, a **timeline** and an **evidence packet**: the FTS
   query, every flow read, FTS's own total, with sha256 hashes.
5. A shortfall pays **in proportion to the gap**: 6% short pays 6% of the payout. 90% goes to the beneficiary (for
   example a pooled humanitarian fund), 10% plus the stake back to the reporter. A delivered pledge adds the reporter's
   stake to the bond. If a source cannot be read, nothing is decided and the stake goes back. Every share is
   **credited**; GEN leaves the contract only through `withdraw()`, to the caller.

**Live app:** [aidpledge-bars26.vercel.app](https://aidpledge-bars26.vercel.app). Pick a donor, a plan and a date to see
what FTS records, against a target, without a wallet. The header switches between Bradbury testnet (chain 4221, GEN
from the [testnet faucet](https://testnet-faucet.genlayer.foundation)) and GenLayer Studio (chain 61999, **Test GEN**).

**Contracts (v2):** Studio [`0x38d91447B1e435D183B062344CF4c5539B96f965`](https://explorer-studio.genlayer.com/address/0x38d91447B1e435D183B062344CF4c5539B96f965),
Bradbury testnet [`0xa32C73fd75FC2e5b52484fcE2B8758D046CbA62F`](https://explorer-bradbury.genlayer.com/address/0xa32C73fd75FC2e5b52484fcE2B8758D046CbA62F).
v1.1 (accepted) stays at [`0xDE5Ec07ed37E5677792833337CF3F5992fc6f0d2`](https://explorer-studio.genlayer.com/address/0xDE5Ec07ed37E5677792833337CF3F5992fc6f0d2); its run is in [`docs/v1/`](docs/v1/).

## Why GenLayer

Two parts of this cannot be done by an ordinary oracle:

- **Reading the promise.** Whether a government press release is a funding pledge by *this* donor for *this* crisis is a
  judgement on free text. Validators each fetch the page and must agree on `MATCH`, `NO_MATCH` or `UNCLEAR`; a fixed
  answer set keeps their agreement strict.
- **Reading the scoreboard.** Every validator queries FTS itself and the sums must agree exactly, so no single party
  reports the number money depends on.
- **Two independent records.** FTS is what agencies and donors report to the UN; IATI is what the donor publishes
  itself. Validators read both and pay only for a gap both show, so a lag on one side cannot cost the donor.

## What v2 adds (Milestone)

- **A second, independent source: the donor's own IATI reports.** A pledge may name the donor's IATI publisher id. At
  pledging, validators read the publisher's name from d-portal and must agree it is this donor (the WFP's file cited
  as the UK's is refused). On a shortfall, they read the donor's humanitarian disbursements and expenditures (DAC 720,
  730, 740) for the plan's country (FTS's alpha-2 `pcode`), dated from the plan's start to the deadline, split by each
  activity's country and sector shares. If those cover the target, the ruling is `UNCLEAR` with code
  `sources_disagree`: no payout, stake back. Otherwise the shortfall is the gap from the **larger** of the two totals.
  IATI unreadable: `UNCLEAR` (`iati_unreachable`). A pledge without a publisher is ruled on FTS alone, as in v1.
- **No GEN rides on a reading.** `create_pledge` and `file_claim` are no longer payable: bonds and stakes come from a
  `deposit()` credit, checked before the validators read and taken only after they agree. A round that ends undecided,
  or a refused pledge, leaves the deposit untouched (v1 sent the bond with the call that needed the reading).
- **Pull payments.** Payouts, rewards, returned stakes and released bonds are credited; `withdraw()` sends a wallet
  everything credited to it, and is the only place GEN leaves the contract. `release_bond` replaces v1's
  `withdraw(pledge_id)`.
- **Running totals.** `totals()` reads four stored numbers (bonds, open stakes, credited, withdrawn) instead of
  looping over every pledge and claim; a test checks them against the sums after every kind of event.
- **Bradbury testnet.** The same source runs on Studio and on Bradbury (Phase 2): `contracts/aid_pledge.bradbury.py`
  is the Studio file with the Bradbury header and without comments (`scripts/bradbury_source.py --check` proves the
  code is otherwise identical), and CI runs the 73 direct tests on both runners.
- **The app** switches networks, deposits what a pledge or a claim needs before sending it, shows "Your GEN in
  AidPledge" with Withdraw, marks each pledge "FTS + IATI" or "FTS only", and shows the IATI reading and query in every
  claim.

## Verified live, on OCHA FTS's and IATI's real records

`scripts/demo.mjs` ran v2 on GenLayer Studio with demo pledges (made by a test wallet, not by any government) backing the
UK's (and, for the two-page case, the EU's) announced funding for Sudan, with **demo targets** chosen to show each
ruling; `scripts/demo-bradbury.mjs` ran the same program on Bradbury testnet, five validators per transaction. Every
transaction hash, the coverage reads, the balance reconciliations and every evidence packet are in
[`docs/REPRODUCTION.md`](docs/REPRODUCTION.md); the v1.1 run is in [`docs/v1/`](docs/v1/).

The announcement is the UK government's
[15 April 2025 press release](https://www.gov.uk/government/news/uk-announces-new-humanitarian-funding-for-sudan)
(£120 million for Sudan). Validators read it as `MATCH` for the UK (FTS organization 2917) and the Sudan Humanitarian
Needs and Response Plan 2025 (FTS plan 1220), and agreed that IATI publisher `GB-GOV-1` (the FCDO) is the UK.

| Demo pledge (by 2026-03-31) | OCHA FTS (committed or paid) | The UK's own IATI reports (humanitarian disbursements to SD since 2025-01-01) | Ruling |
|---|---|---|---|
| **$150M**, FTS + IATI | $141,078,936 in 22 flows: short | $160,709,747 in 14 activities: covers it | **Sources disagree** (`UNCLEAR`): nothing paid, the reporter's stake credited back; the reporter's fresh reading confirmed it. On Bradbury, the same ruling 5/5 |
| **$200M**, FTS + IATI | $141,078,936: short | $160,709,747: short | **Fell short** by the gap from the larger total: $39,290,253 (19.64%), so **0.786 GEN** of 4 credited; the pledger's fresh reading confirmed it, a bystander settled after the window. On Bradbury, 5/5 and conceded |
| **$140M**, FTS + IATI | $141,078,936: met | not needed | **Delivered**; the stake joined the bond and a second claim was refused |
| **$150M**, FTS only | $141,078,936 | — | **Fell short** 5.94% (the v1 rule): **0.119 GEN**, conceded. The same promise as the first row: the second source is what kept the UK from paying for a gap its own reports do not show |
| **ECHO $120M**, FTS only | $123,825,492 in 107 qualifying flows, out of 182 on **two FTS pages** | — | **Delivered**: both pages read, matching FTS's totals |

Also refused on-chain, taking nothing from the deposit: a donor id that is not a number, a bond below the payout, a bond
larger than the deposit (*"deposit first: 20 GEN needed, 15 GEN credited"*), a deadline of 2026-02-31, a plan FTS does
not have, **the UK announcement cited for Germany** (`NO_MATCH`) and **the World Food Programme's IATI file cited as
the UK's**. Every payout was credited; the beneficiary, the reporter and the pledger withdrew, and a second withdraw
was refused (*"Nothing to withdraw"*). `totals()` matched the contract's on-chain balance at six points on Studio and
three on Bradbury, each after every transfer had finalized.

A MetaMask test from the live app on Bradbury (the app deposits first, then backs a $200M pledge with `GB-GOV-1`,
reports the shortfall, concedes it and withdraws) was decided 5/5 at every step: **Fell short, 19.64%**, 0.1965 GEN
paid from the bond, 0.2965 GEN withdrawn. Its six transactions are in `docs/ui-test.json` and in REPRODUCTION.

## Who can do what (and the attacks this blocks)

| Rule | Why |
|---|---|
| The donor and the plan are frozen at pledging from FTS, with the announcement's hash and excerpt | Nobody can later swap who promised what to which crisis |
| Validators must agree the announcement is this donor's pledge for this crisis (`MATCH`), or the bond is refunded | A pledge cannot be pinned on a donor, or a crisis, that never promised anything |
| Only *commitment* and *paid* flows dated by the deadline count; pledges and later flows never do | An announcement is not money, and a late payment does not meet an earlier deadline |
| Claims open 30 days after the deadline; the pledge runs at least 30 days more | FTS reporting lag cannot cause a false shortfall; the pledger cannot leave before claims can come in |
| The bond covers the whole payout; a pledge pays once; a pledge ruled delivered is closed | A confirmed shortfall is always paid in full; no double payouts |
| A shortfall pays pro rata to the gap | A 1% miss does not cost the same as a broken promise |
| FTS failures (and malformed answers) are `UNCLEAR` and return the stake | An outage never decides a ruling |
| Validators read **every page** of FTS's flow list (100 per page, up to 50 pages) and rule only if the flows read match FTS's own totals (`meta.count` and the incoming `flowCount`); otherwise `UNCLEAR` (`incomplete`) and nothing is paid | A shortfall is never computed from part of the record |
| Only the side a ruling goes against contests, once per side; every contest restarts the window | A late FTS report can still be read; nobody spends the other side's only answer |
| Early settlement only against your own interest (the pledger concedes, the reporter accepts) | The reporter or beneficiary cannot rush a payout; the pledger cannot rush taking a stake |
| With an IATI publisher, a shortfall is paid only for the gap both FTS and the donor's own IATI reports show; nothing if the donor's reports cover the pledge | One source's reporting lag cannot cost the donor; one source alone cannot pay out |
| Validators must agree the IATI publisher is this donor, and the plan must cover one country | Another organization's IATI file cannot be used to clear a donor |
| `create_pledge` and `file_claim` send no GEN: bonds and stakes come from a deposit, taken after the reading | A reading that fails consensus cannot strand anyone's GEN |
| Every payout is credited; only `withdraw` sends GEN, to the caller | No settlement fails or pays on someone else's behalf |
| `add_bond` (payable, no reading) never reverts on bad input; it credits the GEN back and returns `REFUNDED: <reason>` | GenLayer keeps the value of a reverted call |

## The app

- **No-wallet first step:** pick a donor and a response plan (or type any FTS ids), a date and a target, and see a
  **funding bar**: gold for money committed or paid by the date, hatched for money dated later (not counted), a navy
  line for the target. Same FTS reads as the contract (`/api/funding`), with every flow listed and linked to FTS.
- **"Back this target with GEN"** opens the pledge form pre-filled from the check, with the funding bar live as you
  change the deadline or target.
- **Every pledge card** shows its funding bar today, the announcement validators read (excerpt, hash, `MATCH`), what it
  still guarantees, when claims open and how long the bond stays locked.
- **Every claim** shows the ruling, its reason, the counted, later and pledged-only amounts, the pro-rata payout and
  each reading's evidence packet.
- **The report form** shows the expected payout before you stake and blocks claims the contract would refund.
- **Studio's 30 requests per minute:** page loads read the registry server-side with one `get_pledges` and one
  `get_claims` call, CDN-cached; the browser keeps its own 24-per-minute budget and shows it.

## Run it

```bash
pip install -r requirements.txt
genvm-lint check contracts/aid_pledge.py
pytest tests/direct/ -v                     # 73 tests: FTS, d-portal, the announcement and the LLM mocked
python scripts/bradbury_source.py --check   # the Bradbury file is this source with the Bradbury header
AIDPLEDGE_NETWORK=bradbury pytest tests/direct/   # the same tests on the Bradbury runner (genlayer-test 0.30)

npm install
node scripts/deploy.mjs
node scripts/verify-code.mjs <address>
node scripts/demo.mjs <address>             # the Studio run (about 30 minutes)
node scripts/deploy-bradbury.mjs && node scripts/demo-bradbury.mjs <address>   # Bradbury testnet
node scripts/reproduction.mjs               # regenerate docs/REPRODUCTION.md

cd frontend && cp .env.example .env.local && npm run dev
```

## Changes in v1.1 (after steward review)

- **Every FTS page is read, and a partial list decides nothing.** v1.0 asked FTS for one page of up to 1,000 flows. Now
  each validator follows FTS's paging (100 flows per page, up to 50 pages), keeps each flow once by id, and computes a
  verdict only if the number of flows read equals FTS's `meta.count` and the incoming flows equal FTS's incoming
  `flowCount`. A missing or failing page, a total that changes while paging, an empty page in the middle or more than
  50 pages make the reading `UNCLEAR` with code `incomplete`: the reporter's stake goes back and nothing is paid.
  `test_every_fts_page_is_read_and_every_qualifying_flow_counted` reads 2,345 flows over 24 pages (page 1 alone would
  count $5M of $115M) and `test_an_incomplete_fts_reading_never_pays` covers each inconsistency, checking that only
  the stake moved. The wallet-free funding check in the app reads FTS the same way.
- **Impossible dates are refunded.** `deadline` and `expires` are checked against the calendar before any date
  arithmetic, so `2026-02-31` returns `REFUNDED: ...` instead of raising and keeping the bond.

## Limits, stated plainly

- The contract does not verify that a pledger is the donor; a pledge is a promise backed by the pledger's own GEN. The
  demo pledges are made by a test wallet, and their targets are demo terms, not findings about any donor.
- FTS shows what donors and agencies report to it. Money that reaches a crisis outside the named plan, or is never
  reported, does not count. The ruling is about FTS records only.
- A pledge is judged by the reading a reporter triggers; the side it goes against can ask once for a fresh reading.
  Flows are stored in the evidence packet up to 40 per reading (all are counted and hashed).
- Amounts are FTS's own US dollar figures (`amountUSD`); currency conversion is FTS's. IATI amounts are d-portal's
  US dollar conversions of the donor's transactions.
- IATI counts what the donor reports as humanitarian (DAC 720/730/740) for the whole country, not only the named plan,
  so it can only lower a payout or stop one, never raise it. Disbursements and expenditures count; IATI commitments do
  not (they often span several years). A donor whose humanitarian aid is published by an agency other than the named
  publisher is covered only if the pledger names that agency.
- d-portal is the IATI Secretariat's public query service; if it is down, a reading is `UNCLEAR` and nothing is paid.

MIT licensed.
