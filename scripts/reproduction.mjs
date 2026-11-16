// Renders docs/REPRODUCTION.md from docs/demo-run.json (Studio, written by scripts/demo.mjs), the claims and pledges as
// the contract reports them now, docs/bradbury/demo-run.json (Bradbury testnet, scripts/demo-bradbury.mjs) and, when
// present, docs/ui-test.json (a MetaMask run from the live app).
//
//   node scripts/reproduction.mjs

import { existsSync, readFileSync, writeFileSync } from "fs";
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const run = JSON.parse(readFileSync(new URL("../docs/demo-run.json", import.meta.url), "utf8"));
const client = createClient({ chain: studionet, endpoint: "https://studio.genlayer.com/api" });
async function read(functionName, args) {
  // Studio allows 30 contract reads per minute per IP: wait and retry when it says so.
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.readContract({ address: run.contract, functionName, args });
    } catch (err) {
      if (!/rate limit/i.test(String(err?.message)) || attempt >= 8) throw err;
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
}
const field = (o, k) => (o instanceof Map ? o.get(k) : o[k]);
const fmt = (wei, d = 2) => (Number(BigInt(String(wei))) / 1e18).toFixed(d);
run.rulings = [];
for (const id of run.claims.filter(Boolean)) {
  const c = await read("get_claim", [id]);
  const steps = JSON.parse(field(c, "timeline_json")).map((s) => s.event + (s.verdict ? `:${s.verdict}` : "") + (s.outcome ? `:${s.outcome}` : "")).join(" → ");
  const p = await read("get_pledge", [field(c, "pledge_id")]);
  const promise = `${field(c, "pledge_id")}: ${field(p, "donor_name").replace(/, Government of$/, "")} → plan ${field(p, "plan_id")}, $${Number(field(p, "target_usd")).toLocaleString("en-US")} by ${field(p, "deadline")}`;
  run.rulings.push({ id, promise, iati: field(p, "iati_ref"), facts: JSON.parse(field(c, "facts_json")), verdict: field(c, "verdict"), code: field(c, "code"), why: field(c, "why"), steps });
}
run.summary = [];
for (const id of run.pledges) {
  const p = await read("get_pledge", [id]);
  run.summary.push(
    `${id} ${field(p, "donor_name").replace(/, Government of$/, "").padEnd(15)} plan ${field(p, "plan_id")}  $${Number(field(p, "target_usd")).toLocaleString("en-US").padStart(11)} by ${field(p, "deadline")}  bond ${fmt(field(p, "bond")).padStart(5)} GEN  paid ${fmt(field(p, "total_paid"))} GEN  outcome ${field(p, "outcome") || "-"}  open claims ${field(p, "pending")}`
  );
}
const balances = [];
for (const [k, a] of Object.entries(run.accounts)) {
  const res = await fetch("https://studio.genlayer.com/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [a, "latest"] }),
  }).then((r) => r.json());
  balances.push(`${k.padEnd(10)} ${fmt(BigInt(res.result))} GEN`);
}
const totals = JSON.parse(await read("totals", []));
const contractBalance = BigInt(
  (await fetch("https://studio.genlayer.com/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [run.contract, "latest"] }),
  }).then((r) => r.json())).result
);
const tx = (h) => `[\`${h.slice(0, 10)}…\`](https://explorer-studio.genlayer.com/tx/${h})`;
const btx = (h) => `[\`${h.slice(0, 10)}…\`](https://explorer-bradbury.genlayer.com/tx/${h})`;
const usdOf = (n) => (n === undefined || n === null ? "—" : `$${Number(n).toLocaleString("en-US")}`);
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const rows = run.log.map((r) => {
  const result = r.refused ? `refused: ${r.refused}` : r.returned ?? "";
  return `| ${r.who} | \`${esc(r.call)}\` | ${r.value === "0" ? "" : r.value} | ${r.status} | ${r.exec} | ${esc(result).slice(0, 260)} | ${tx(r.hash)} |`;
});

let uiTest = "";
try {
  const ui = JSON.parse(readFileSync(new URL("../docs/ui-test.json", import.meta.url), "utf8"));
  const utx = ui.network === "bradbury" ? btx : tx;
  uiTest = `## Wallet test from the live app

${ui.note} Wallet \`${ui.wallet}\`.

| Step | GEN sent | Result | Tx |
|---|---|---|---|
${ui.steps.map(([step, value, result, hash]) => `| ${esc(step)} | ${value} | ${esc(result)} | ${utx(hash)} |`).join("\n")}

`;
} catch {
  // no UI test recorded
}

const recon = [
  ...(run.reconciliations ?? []),
  { label: "now (when this file was generated)", bonds: totals.bonds, pending_stakes: totals.pending_stakes, owed: totals.owed, expected: totals.expected_balance, balance: contractBalance.toString(), ok: BigInt(totals.expected_balance) === contractBalance },
].map((r) => `| ${r.label} | ${fmt(r.bonds)} | ${fmt(r.pending_stakes)} | ${fmt(r.owed ?? 0)} | ${fmt(r.expected)} | ${fmt(r.balance)} | ${r.ok ? "match" : "MISMATCH"} |`);
const sources = run.rulings.map((c) => {
  const f = c.facts;
  const confirmed = f.iati_usd === undefined ? f.funded_usd : Math.max(f.funded_usd ?? 0, f.iati_usd);
  return `| ${c.id} | ${c.iati || "— (FTS only)"} | ${usdOf(f.target_usd)} | ${usdOf(f.funded_usd)} (${f.flows_counted ?? 0} flows) | ${f.iati_usd === undefined ? (c.iati ? "not read: FTS met the target" : "—") : `${usdOf(f.iati_usd)} (${f.iati_activities} activities, ${f.iati_country} ${f.iati_from} to ${f.deadline})`} | ${usdOf(confirmed)} | ${f.shortfall_usd ? `${usdOf(f.shortfall_usd)} (${(f.shortfall_bp / 100).toFixed(2)}%)` : "—"} | **${c.verdict}** (${c.code}) |`;
});
const credited = Object.entries(run.credited ?? {}).map(([k, v]) => `${k} ${fmt(v, 4)} GEN`).join(", ");
let bradbury = "";
const bPath = new URL("../docs/bradbury/demo-run.json", import.meta.url);
if (existsSync(bPath)) {
  const b = JSON.parse(readFileSync(bPath, "utf8"));
  const BX = "https://explorer-bradbury.genlayer.com";
  bradbury = `## Bradbury testnet run

The same program (\`contracts/aid_pledge.bradbury.py\`: the Studio source with the Bradbury header and without comments,
checked by \`python3 scripts/bradbury_source.py --check\`; \`node scripts/verify-code-bradbury.mjs ${b.contract}\` prints
\`identical\`) at [\`${b.contract}\`](${BX}/address/${b.contract}), run by \`scripts/demo-bradbury.mjs\`. Five Bradbury
validators read OCHA FTS, d-portal (IATI) and the announcement for every reading. Bradbury reports each transaction's
decision, execution result and votes; results were read back from the contract. A round where the leader ran out of
time changes nothing and is sent again.

Accounts: ${Object.entries(b.accounts).map(([k, a]) => `${k} \`${a}\``).join(", ")}.

| Claim | Pledge | Ruling | Reason (on-chain) |
|---|---|---|---|
${Object.entries(b.claims).map(([id, c]) => { const p = b.pledges[c.pledge_id]; return `| ${id} | ${c.pledge_id}: $${Number(p.target_usd).toLocaleString("en-US")} by ${p.deadline}, IATI ${p.iati_ref} | **${c.verdict}** (${c.code}) | ${esc(c.why)} |`; }).join("\n")}

| Who | Call | GEN | Status | Execution | Votes | Seconds | Tx |
|---|---|---|---|---|---|---|---|
${b.log.map((r) => `| ${r.who} | \`${esc(r.call).slice(0, 120)}\` | ${r.value === "0.0000" ? "" : r.value} | ${r.status} | ${r.execution} | ${r.votes.join("/")} | ${r.seconds} | ${btx(r.hash)} |`).join("\n")}

| Point | Bonds | Open stakes | Credited | Expected | Contract balance | Match |
|---|---|---|---|---|---|---|
${b.reconciliations.map((r) => `| ${r.label} | ${fmt(r.bonds, 4)} | ${fmt(r.pending_stakes, 4)} | ${fmt(r.owed, 4)} | ${fmt(r.expected, 4)} | ${fmt(r.balance, 4)} | ${r.ok ? "yes" : "**no**"} |`).join("\n")}

`;
}
const coverage = Object.entries(run.coverages ?? {}).map(
  ([k, c]) => `| ${k} | ${fmt(c.payout)} | ${fmt(c.liability)} | ${fmt(c.bond)} | ${c.covered ? "yes" : "no"} | ${c.pending_claims} | ${c.outcome || "—"} | ${c.deadline} | ${c.claims_open} | ${c.locked_until} |`
);
const packets = Object.entries(run.evidence ?? {}).flatMap(([id, e]) =>
  e.packets.map((p, i) => `| ${id} #${i + 1} | ${p.read_at ?? ""} | ${p.flows_total ?? 0} | ${p.pages_read ?? "—"} | ${p.iati_source ? `[d-portal query](${p.iati_source.replace(/\|/g, "%7C")})` : "—"} | \`${(p.flows_sha256 || "—").slice(0, 16)}…\` | \`${(p.packet_sha256 || "").slice(0, 16)}…\` |`)
);
const payouts = Object.entries(run.evidence ?? {}).flatMap(([id, e]) =>
  e.timeline.filter((s) => s.event === "settled" && s.outcome === "paid").map((s) => `| ${id} | ${(s.share_bp / 100).toFixed(2)}% | ${fmt(BigInt(s.beneficiary) + BigInt(s.reporter), 4)} | ${fmt(s.beneficiary, 4)} | ${fmt(s.reporter, 4)} |`)
);
const ann = run.announcement;
const rulings = run.rulings.map((c) => `| ${c.id} | ${c.promise} | **${c.verdict}** (${c.code}) | ${esc(c.why)} | ${c.steps} |`);

const doc = `# AidPledge v2: reproduction of the live runs

Live run of \`scripts/demo.mjs\` on GenLayer Studio, against **real** records from OCHA's Financial Tracking Service
(FTS), the UK's own IATI reports (read through [d-portal](https://d-portal.org)) and a real public announcement on
GOV.UK, with real validator consensus and real LLM calls; then the same program on Bradbury testnet. Generated by
\`scripts/reproduction.mjs\` from [\`demo-run.json\`](demo-run.json) and [\`bradbury/demo-run.json\`](bradbury/demo-run.json).
The v1.1 run is in [\`v1/REPRODUCTION.md\`](v1/REPRODUCTION.md).

- Contract: [\`${run.contract}\`](https://explorer-studio.genlayer.com/address/${run.contract})
  (\`node scripts/verify-code.mjs ${run.contract}\` prints \`identical\`: the deployed code is \`contracts/aid_pledge.py\`).
- Throwaway accounts: ${Object.entries(run.accounts).map(([k, a]) => `${k} \`${a}\``).join(", ")}.
- The pledges are **demo pledges made by a test wallet**, not by any government. They back the UK's announced funding for
  Sudan (FTS organization 2917, plan 1220; IATI publisher \`GB-GOV-1\`, the FCDO) with **demo targets** chosen to show
  each ruling. The FTS and IATI records and the rulings are real; a "shortfall" means the demo target was not met, not
  a finding about the UK.

## The announcement validators read

Every pledge must cite the donor's public announcement. At \`create_pledge\` validators fetch it and answer one question:
is this the donor's funding pledge for the crisis this plan responds to? Only MATCH lets the pledge in. For ${run.pledges[0]}:

- URL: ${ann.url}
- Answer: **${ann.answer}**, text sha256 \`${ann.sha256}\` (${ann.chars} characters read, page \`<main>\` only)
- Excerpt stored on-chain: “${esc(ann.excerpt.slice(0, 300))}…”

The same announcement cited for Germany (organization 4306) was refused (NO_MATCH), and the World Food Programme's IATI
file (\`XM-DAC-41140\`) cited as the UK's was refused because validators did not read that publisher as the UK. A
refused pledge took nothing from the deposit (see the first rows of the transaction table and the first reconciliation).

## Two sources per ruling

FTS is checked first, in code: commitments and payments from the donor to the plan, dated by the deadline. If they fall
short and the pledge names an IATI publisher, validators read the humanitarian disbursements and expenditures (DAC
720/730/740) the donor itself published for the plan's country, from the plan's start to the deadline. If those cover
the target, the sources disagree and nothing is paid; otherwise only the gap from the larger total is paid.

| Claim | IATI publisher | Target | FTS (by deadline) | Donor's own IATI reports | Confirmed (larger) | Shortfall paid on | Ruling |
|---|---|---|---|---|---|---|---|
${sources.join("\n")}

## Rulings and their reasons

The \`why\` column is the contract's own explanation (\`explain_claim\`), built only from facts all validators agreed on.

| Claim | Promise checked | Ruling | Why (on-chain) | Timeline |
|---|---|---|---|---|
${rulings.join("\n")}

## Pro-rata payouts

A shortfall pays \`payout × shortfall ÷ target\`: 90% to the beneficiary, 10% to the reporter (who also gets the stake back).

| Claim | Shortfall | Paid (GEN) | Beneficiary | Reporter |
|---|---|---|---|---|
${payouts.join("\n")}

## Payout coverage

The bond must cover the whole payout, and a pledge pays once, so a confirmed shortfall is always paid in full.
Claims open 30 days after the deadline (FTS reporting lag); the bond stays until the pledge expires and every claim is
settled. \`coverage(pledge_id)\` as read during the run:

| Pledge | Payout | Liability (GEN) | Bond (GEN) | Covered | Open claims | Outcome | Deadline | Claims open | Locked until |
|---|---|---|---|---|---|---|---|---|---|
${coverage.join("\n")}

## Balance reconciliation

\`totals()\` (running totals of active bonds, the stakes of open claims and GEN credited but not withdrawn) against the
contract's actual balance (\`eth_getBalance\`), read only after every transaction touching the contract was FINALIZED:

| When | Active bonds | Open stakes | Credited | Expected | Contract balance | Result |
|---|---|---|---|---|---|---|
${recon.join("\n")}

Credited after every claim was settled, before the withdrawals: ${credited}.

## Evidence packets

Every reading stores a packet on the claim (\`evidence_json\`): the FTS query, every incoming flow read (id, status,
date, USD, first reported), the d-portal query when IATI was read, the flows' sha256, and a hash of the whole packet,
which the claim's timeline also records. Validators read every FTS page (100 flows each) and rule only when the flows
read match FTS's own totals (\`meta.count\` and the incoming \`flowCount\`); otherwise the reading is UNCLEAR.

| Claim / reading | Read at (UTC) | Flows | FTS pages | IATI | Flows sha256 | Packet sha256 |
|---|---|---|---|---|---|---|
${packets.join("\n")}

## Final state

\`\`\`
${run.summary.join("\n")}
\`\`\`

Wallet balances after finalization (funded with pledger 100, reporter 20, fund 1, bystander 1 GEN).

\`\`\`
${balances.join("\n")}
\`\`\`

${bradbury}${uiTest}
## Every transaction (Studio)

A refused call is still ACCEPTED by consensus; the contract outcome is the \`exec\` column (\`ERROR\` = the contract raised,
on purpose here). In v2, \`create_pledge\` and \`file_claim\` carry no GEN (bonds and stakes come from a deposit), so a
refused one simply raises and takes nothing; GEN leaves the contract only through \`withdraw\`.

| Who | Call | GEN sent | Consensus | Exec | Returned / refused | Tx |
|---|---|---|---|---|---|---|
${rows.join("\n")}

## Run it yourself

\`\`\`bash
npm install
node scripts/deploy.mjs                      # prints the new contract address
node scripts/verify-code.mjs <address>       # deployed code == contracts/aid_pledge.py
node scripts/demo.mjs <address>              # about 30 minutes: includes one 10-minute response window
node scripts/deploy-bradbury.mjs             # Bradbury testnet (funded key in ~/.config/genlayer-demos/)
node scripts/demo-bradbury.mjs <address>
node scripts/reproduction.mjs                # regenerates this file
\`\`\`
`;

writeFileSync(new URL("../docs/REPRODUCTION.md", import.meta.url), doc);
console.log(`wrote docs/REPRODUCTION.md (${run.log.length} transactions)`);
