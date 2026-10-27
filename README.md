# AidPledge

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/license/mit/)

<img src="assets/aidpledge-logo.png" alt="AidPledge logo" width="96" align="right" />

**Humanitarian funding pledges, backed by GEN and checked by GenLayer validators against the UN's own funding records.**

Donor governments announce aid at pledging conferences: "£120 million for Sudan", "€100 million for Yemen". Months
later, few people check how much of it was actually committed or paid, and nothing happens when a pledge falls short.
The UN does keep the scoreboard: OCHA's [Financial Tracking Service](https://fts.unocha.org) (FTS) records every
reported flow of humanitarian money, by donor, by response plan, by date and by status (pledged, committed, paid).

AidPledge puts money behind an announced pledge:

1. A **pledger** (the donor itself, or anyone backing a donor's public pledge with their own GEN) names a **donor**
   (FTS organization id), a **response plan** (FTS plan id), a **target** in US dollars and a **deadline**, and cites
   the donor's **public announcement**. Validators read the donor and the plan from FTS and freeze them. They also
   fetch the announcement (only the page's `<main>` content) and answer one question: is this the donor's funding
   pledge for the crisis this plan responds to? Anything but `MATCH` refunds the bond. The bond must cover the payout,
   and the pledge runs at least 60 days past the deadline.
2. **30 days after the deadline** (donors report to FTS late), **anyone reports** a shortfall by staking 10% of the
   payout.
3. **Every validator** reads every incoming flow from the donor to the plan on FTS and decides **in code**: flows with
   status *commitment* or *paid*, dated on or before the deadline, count. Bare pledges and flows dated later are shown
   but never counted. Counted funding ≥ target: **delivered**. Below: **fell short**, by exactly how much.
4. The side the ruling goes against may ask **once** for a fresh reading within 10 minutes (a late report may have
   reached FTS). Every ruling stores a **plain-English reason**, a **timeline** and an **evidence packet**: the FTS
   query, every flow read, FTS's own total, with sha256 hashes.
5. A shortfall pays **in proportion to the gap**: 6% short pays 6% of the payout. 90% goes to the beneficiary (for
   example a pooled humanitarian fund), 10% plus the stake back to the reporter. A delivered pledge adds the reporter's
   stake to the bond. If FTS cannot be read, nothing is decided and the stake goes back.

**Live app:** [aidpledge-bars26.vercel.app](https://aidpledge-bars26.vercel.app). Pick a donor, a plan and a date to see
what FTS records, against a target, without a wallet. Writes need MetaMask on GenLayer Studio (chain 61999); **Test GEN**
funds your wallet.

**Contract:** [`0xA51aE3DBecF765A554479B5f8f83aaeB374872C7`](https://explorer-studio.genlayer.com/address/0xA51aE3DBecF765A554479B5f8f83aaeB374872C7) on GenLayer Studio.

## Why GenLayer

Two parts of this cannot be done by an ordinary oracle:

- **Reading the promise.** Whether a government press release is a funding pledge by *this* donor for *this* crisis is a
  judgement on free text. Validators each fetch the page and must agree on `MATCH`, `NO_MATCH` or `UNCLEAR`; a fixed
  answer set keeps their agreement strict.
- **Reading the scoreboard.** Every validator queries FTS itself and the sums must agree exactly, so no single party
  reports the number money depends on.

## Verified live, on OCHA FTS's real records

`scripts/demo.mjs` ran demo pledges (made by a test wallet, not by any government) backing the UK's announced funding
for Sudan, with **demo targets** chosen to show each ruling, real validator consensus and real LLM calls. Every
transaction hash, the coverage reads, the balance reconciliation and every evidence packet are in
[`docs/REPRODUCTION.md`](docs/REPRODUCTION.md).

The announcement is the UK government's
[15 April 2025 press release](https://www.gov.uk/government/news/uk-announces-new-humanitarian-funding-for-sudan)
(£120 million for Sudan). Validators read it as `MATCH` for the UK (FTS organization 2917) and the Sudan Humanitarian
Needs and Response Plan 2025 (FTS plan 1220).

| Demo pledge | What FTS records (committed or paid, by the deadline) | Ruling and stored reason |
|---|---|---|
| UK → Sudan 2025, **$150M by 2026-03-31**, payout 4 GEN | $141,078,936 in 22 flows | **Fell short**: *"…$8,921,064 short of the pledged $150,000,000 (5.94% short)."* The reporter and the beneficiary could not settle early; the pledger's fresh reading confirmed it; a bystander settled after the window: **0.238 GEN** paid (5.94% of 4 GEN) |
| UK → Sudan 2025, **$140M by 2026-03-31** | $141,078,936 | **Delivered**: *"…The pledged $140,000,000 was met."* The reporter's fresh reading confirmed it; the stake joined the bond, and a second claim was refused |
| UK → Sudan 2025, **$150M by 2025-12-31** | $108,334,944 | **Fell short** by 27.77%; the pledger conceded at once: **0.556 GEN** paid (27.77% of 2 GEN) |
| UK → Sudan 2025, $150M by 2026-12-31 | not due | the claim was refunded (claims open 2027-01-30); the pledger's `withdraw` was refused |

Also refused on-chain, with the GEN sent back: a donor id that is not a number, a plan FTS does not have, a bond below
the payout, a pledge ending before reports and claims can come in, **the UK announcement cited for Germany**
(`NO_MATCH`), **the Sudan announcement cited for the Ukraine plan** (`NO_MATCH`), a claim with the wrong stake, a second
claim while one is open, and a claim on a pledge already ruled and paid. The contract's balance was reconciled with
`totals()` (active bonds plus open stakes) at three points of the run, each time after every transfer had finalized.

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
| Only the side a ruling goes against contests, once per side; every contest restarts the window | A late FTS report can still be read; nobody spends the other side's only answer |
| Early settlement only against your own interest (the pledger concedes, the reporter accepts) | The reporter or beneficiary cannot rush a payout; the pledger cannot rush taking a stake |
| Payable calls never revert; they refund and return `REFUNDED: <reason>` | GenLayer keeps the value of a reverted call |

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
pytest tests/direct/ -v                     # 40 tests, FTS, the announcement and the LLM mocked

npm install
node scripts/deploy.mjs
node scripts/verify-code.mjs <address>
node scripts/demo.mjs <address>             # the live run above (about 30 minutes)
node scripts/reproduction.mjs               # regenerate docs/REPRODUCTION.md

cd frontend && cp .env.example .env.local && npm run dev
```

## Limits, stated plainly

- The contract does not verify that a pledger is the donor; a pledge is a promise backed by the pledger's own GEN. The
  demo pledges are made by a test wallet, and their targets are demo terms, not findings about any donor.
- FTS shows what donors and agencies report to it. Money that reaches a crisis outside the named plan, or is never
  reported, does not count. The ruling is about FTS records only.
- A pledge is judged by the reading a reporter triggers; the side it goes against can ask once for a fresh reading.
  Flows are stored in the evidence packet up to 40 per reading (all are counted and hashed).
- Amounts are FTS's own US dollar figures (`amountUSD`); currency conversion is FTS's.

MIT licensed.
