// Renders docs/REPRODUCTION.md from docs/demo-run.json (written by scripts/demo.mjs) plus the
// claims and pledges as the contract reports them now.
//
//   node scripts/reproduction.mjs

import { readFileSync, writeFileSync } from "fs";
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const run = JSON.parse(readFileSync(new URL("../docs/demo-run.json", import.meta.url), "utf8"));
const client = createClient({ chain: studionet, endpoint: "https://studio.genlayer.com/api" });
const read = (functionName, args) => client.readContract({ address: run.contract, functionName, args });
const field = (o, k) => (o instanceof Map ? o.get(k) : o[k]);
const fmt = (wei, d = 2) => (Number(BigInt(String(wei))) / 1e18).toFixed(d);
run.rulings = [];
for (const id of run.claims.filter(Boolean)) {
  const c = await read("get_claim", [id]);
  const steps = JSON.parse(field(c, "timeline_json")).map((s) => s.event + (s.verdict ? `:${s.verdict}` : "") + (s.outcome ? `:${s.outcome}` : "")).join(" → ");
  const p = await read("get_pledge", [field(c, "pledge_id")]);
  const promise = `${field(c, "pledge_id")}: ${field(p, "donor_name").replace(/, Government of$/, "")} → plan ${field(p, "plan_id")}, $${Number(field(p, "target_usd")).toLocaleString("en-US")} by ${field(p, "deadline")}`;
  run.rulings.push({ id, promise, verdict: field(c, "verdict"), code: field(c, "code"), why: field(c, "why"), steps });
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
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const rows = run.log.map((r) => {
  const result = r.refused ? `refused: ${r.refused}` : r.returned ?? "";
  return `| ${r.who} | \`${esc(r.call)}\` | ${r.value === "0" ? "" : r.value} | ${r.status} | ${r.exec} | ${esc(result).slice(0, 260)} | ${tx(r.hash)} |`;
});

let uiTest = "";
try {
  const ui = JSON.parse(readFileSync(new URL("../docs/ui-test.json", import.meta.url), "utf8"));
  uiTest = `## Wallet test from the live app

${ui.note} Wallet \`${ui.wallet}\`. Every transaction is FINALIZED with execution result SUCCESS.

| Step | GEN sent | Result | Tx |
|---|---|---|---|
${ui.steps.map(([step, value, result, hash]) => `| ${esc(step)} | ${value} | ${esc(result)} | ${tx(hash)} |`).join("\n")}

`;
} catch {
  // no UI test recorded
}

const recon = [
  ...(run.reconciliations ?? []),
  { label: "now (when this file was generated)", bonds: totals.bonds, pending_stakes: totals.pending_stakes, expected: totals.expected_balance, balance: contractBalance.toString(), ok: BigInt(totals.expected_balance) === contractBalance },
].map((r) => `| ${r.label} | ${fmt(r.bonds)} | ${fmt(r.pending_stakes)} | ${fmt(r.expected)} | ${fmt(r.balance)} | ${r.ok ? "match" : "MISMATCH"} |`);
const coverage = Object.entries(run.coverages ?? {}).map(
  ([k, c]) => `| ${k} | ${fmt(c.payout)} | ${fmt(c.liability)} | ${fmt(c.bond)} | ${c.covered ? "yes" : "no"} | ${c.pending_claims} | ${c.outcome || "—"} | ${c.deadline} | ${c.claims_open} | ${c.locked_until} |`
);
const packets = Object.entries(run.evidence ?? {}).flatMap(([id, e]) =>
  e.packets.map((p, i) => `| ${id} #${i + 1} | ${p.read_at ?? ""} | ${p.flows_total ?? 0} | ${p.fts_total_incoming ? "$" + Number(p.fts_total_incoming).toLocaleString("en-US") : "—"} | \`${(p.flows_sha256 || "—").slice(0, 16)}…\` | \`${(p.packet_sha256 || "").slice(0, 16)}…\` | ${p.pages_read ?? "—"} |`)
);
const payouts = Object.entries(run.evidence ?? {}).flatMap(([id, e]) =>
  e.timeline.filter((s) => s.event === "settled" && s.outcome === "paid").map((s) => `| ${id} | ${(s.share_bp / 100).toFixed(2)}% | ${fmt(BigInt(s.beneficiary) + BigInt(s.reporter), 4)} | ${fmt(s.beneficiary, 4)} | ${fmt(s.reporter, 4)} |`)
);
const ann = run.announcement;
const rulings = run.rulings.map((c) => `| ${c.id} | ${c.promise} | **${c.verdict}** (${c.code}) | ${esc(c.why)} | ${c.steps} |`);

const doc = `# Reproduction log

Live run of \`scripts/demo.mjs\` on GenLayer Studio, against **real** records from OCHA's Financial Tracking Service
(FTS) and a real public announcement on GOV.UK, with real validator consensus and real LLM calls. Generated by
\`scripts/reproduction.mjs\` from [\`demo-run.json\`](demo-run.json).${run.recovered_from_console_log ? `
(The run completed, but its last step, writing \`demo-run.json\`, failed on a variable-name bug since fixed in
\`scripts/demo.mjs\`; the file was rebuilt from the run's console output, with each transaction's GEN value read back
from \`eth_getTransactionByHash\` and the evidence and coverage read from the contract.)` : ""}

- Contract: [\`${run.contract}\`](https://explorer-studio.genlayer.com/address/${run.contract})
  (\`node scripts/verify-code.mjs ${run.contract}\` prints \`identical\`: the deployed code is \`contracts/aid_pledge.py\`).
- Throwaway accounts: ${Object.entries(run.accounts).map(([k, a]) => `${k} \`${a}\``).join(", ")}.
- The pledges are **demo pledges made by a test wallet**, not by any government. They back the UK's announced funding for
  Sudan (FTS organization 2917, plan 1220) with **demo targets** chosen to show each ruling. The FTS records and the rulings
  are real; a "shortfall" means the demo target was not met, not a finding about the UK.

## The announcement validators read

Every pledge must cite the donor's public announcement. At \`create_pledge\` validators fetch it and answer one question:
is this the donor's funding pledge for the crisis this plan responds to? Only MATCH lets the pledge in. For ${run.pledges[0]}:

- URL: ${ann.url}
- Answer: **${ann.answer}**, text sha256 \`${ann.sha256}\` (${ann.chars} characters read, page \`<main>\` only)
- Excerpt stored on-chain: “${esc(ann.excerpt.slice(0, 300))}…”

The same announcement cited for Germany (organization 4306), or for the Ukraine plan (1271), was refused with
NO_MATCH (see the first rows of the transaction table).

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

\`totals()\` (active bonds plus the stakes of open claims) against the contract's actual balance (\`eth_getBalance\`),
read only after every transaction touching the contract was FINALIZED:

| When | Active bonds | Open stakes | Expected | Contract balance | Result |
|---|---|---|---|---|---|
${recon.join("\n")}

## Evidence packets

Every reading stores a packet on the claim (\`evidence_json\`): the FTS query, every incoming flow read (id, status,
date, USD, first reported), FTS's own incoming total, the flows' sha256, and a hash of the whole packet, which the
claim's timeline also records. Since v1.1 validators read every FTS page (100 flows each) and rule only when the flows
read match FTS's own totals (\`meta.count\` and the incoming \`flowCount\`); otherwise the reading is UNCLEAR and nothing is paid.

| Claim / reading | Read at (UTC) | Flows | FTS incoming total | Flows sha256 | Packet sha256 | FTS pages read |
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

${uiTest}
## Every transaction

A refused call is still ACCEPTED by consensus; the contract outcome is the \`exec\` column (\`ERROR\` = the contract raised,
on purpose here). Payable calls never raise: they return \`REFUNDED: <reason>\` and send the GEN back, because GenLayer
keeps the value of a reverted call.

| Who | Call | GEN sent | Consensus | Exec | Returned / refused | Tx |
|---|---|---|---|---|---|---|
${rows.join("\n")}

## Run it yourself

\`\`\`bash
npm install
node scripts/deploy.mjs                      # prints the new contract address
node scripts/verify-code.mjs <address>       # deployed code == contracts/aid_pledge.py
node scripts/demo.mjs <address>              # about 30 minutes: includes one 10-minute response window
node scripts/reproduction.mjs                # regenerates this file
\`\`\`
`;

writeFileSync(new URL("../docs/REPRODUCTION.md", import.meta.url), doc);
console.log(`wrote docs/REPRODUCTION.md (${run.log.length} transactions)`);
