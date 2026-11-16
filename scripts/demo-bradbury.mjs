// Live run of AidPledge v2 on Bradbury testnet (Phase 2): five independent validators read OCHA FTS, the donor's own
// IATI reports (through d-portal) and the GOV.UK announcement.
//
//   node scripts/demo-bradbury.mjs <contract-address>      # writes docs/bradbury/demo-run.json
//
// Test wallets (keys outside the repo, in ~/.config/genlayer-demos/), funded from the GenLayer testnet faucet. The
// pledges are DEMO pledges with demo targets; the FTS flows, IATI transactions and the announcement are real.
// Bradbury reports each transaction's decision, execution result and votes, not the contract's return value, so every
// result below is read back from the contract.

import { mkdirSync, writeFileSync } from "fs";
import { accountFrom, balance, clientFor, gen, keyFile, read, write } from "./bradbury.mjs";

const [CONTRACT] = process.argv.slice(2);
if (!CONTRACT) {
  console.error("usage: node scripts/demo-bradbury.mjs <contract-address>");
  process.exit(1);
}
const GEN = 10n ** 18n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wallets = {
  pledger: accountFrom(keyFile("fieldcall-bradbury-sponsor.json")),
  reporter: accountFrom(keyFile("payclear-bradbury-auditor-a.json")),
  beneficiary: accountFrom(keyFile("payclear-bradbury-auditor-b.json")),
};
const C = Object.fromEntries(Object.entries(wallets).map(([k, a]) => [k, clientFor(a)]));
const log = [];
const plain = (o) => JSON.parse(JSON.stringify(o instanceof Map ? Object.fromEntries(o) : o, (k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v)));

async function send(who, functionName, args = [], opts = {}) {
  const { expect = "ok", ...rest } = opts;
  const extra = functionName === "withdraw" ? { payee: wallets[who].address, leader: 120n, validator: 120n } : {};
  const r = await write(C[who], CONTRACT, functionName, args, { ...extra, ...rest });
  const row = { who, call: `${functionName}(${args.map((a) => JSON.stringify(typeof a === "bigint" ? a.toString() : a)).join(", ")})`, value: gen(rest.value ?? 0n), ...r };
  log.push(row);
  console.log(`${who.padEnd(11)} ${row.call.slice(0, 74).padEnd(74)} ${r.status} ${r.execution} [${r.votes.join("/")}] ${r.seconds}s ${r.hash}`);
  if (expect === "ok" && !r.ok) throw new Error(`${functionName} did not complete: ${r.status} ${r.execution}`);
  if (expect === "refused" && r.execution !== "FINISHED_WITH_ERROR") throw new Error(`${functionName} was expected to be refused, got ${r.status} ${r.execution}`);
  return r;
}

const reconciliations = [];
async function reconcile(label) {
  // A withdraw's transfer leaves the contract about a minute after the withdraw finalizes.
  for (let i = 0; i < 12; i++) {
    const t = JSON.parse(await read(CONTRACT, "totals"));
    const onChain = await balance(C.pledger, CONTRACT);
    if (BigInt(t.expected_balance) === onChain || i === 11) {
      const ok = BigInt(t.expected_balance) === onChain;
      reconciliations.push({ label, bonds: t.bonds, pending_stakes: t.pending_stakes, owed: t.owed, expected: t.expected_balance, balance: onChain.toString(), ok });
      console.log(`  reconcile (${label}): bonds ${gen(t.bonds)} + open stakes ${gen(t.pending_stakes)} + credited ${gen(t.owed)} = ${gen(t.expected_balance)} GEN; contract balance ${gen(onChain)} GEN ${ok ? "OK" : "MISMATCH"}`);
      if (!ok) throw new Error("balance mismatch");
      return;
    }
    await sleep(15000);
  }
}

const UK = "2917", SUDAN = "1220", FCDO = "GB-GOV-1", WFP = "XM-DAC-41140";
const ANNOUNCEMENT = "https://www.gov.uk/government/news/uk-announces-new-humanitarian-funding-for-sudan";
const UNTIL = "2027-03-31";
const first = (await read(CONTRACT, "get_pledges", [0, 200])).length;
let nextClaim = (await read(CONTRACT, "get_claims", [0, 200])).length;
const pid = (n) => `pledge_${first + n}`;
const terms = (target, iati) => [UK, SUDAN, target, "2026-03-31", ANNOUNCEMENT, GEN, wallets.beneficiary.address, UNTIL, iati, GEN];
console.log("contract", CONTRACT);
for (const [k, a] of Object.entries(wallets)) console.log(k.padEnd(11), a.address, gen(await balance(C.pledger, a.address)), "GEN");

// Top the pledger's credit up to 3 GEN (a run cut short by a leader timeout may have deposited already).
const credited = BigInt(await read(CONTRACT, "owed_to", [wallets.pledger.address.toLowerCase()]));
if (credited < 3n * GEN) await send("pledger", "deposit", [], { value: 3n * GEN - credited, leader: 120n, validator: 120n });
// Refused: the WFP's IATI file cited as the UK's. Nothing is taken from the deposit.
await send("pledger", "create_pledge", terms(150_000_000, WFP), { expect: "refused" }); // a leader timeout is sent again
await send("pledger", "create_pledge", terms(150_000_000, FCDO)); // P0: FTS short, the UK's own IATI reports cover it
await send("pledger", "create_pledge", terms(200_000_000, FCDO)); // P1: both sources short
await reconcile("two pledges bonded from the deposit, 1 GEN still credited");

await send("reporter", "deposit", [], { value: 3n * GEN / 10n, leader: 120n, validator: 120n });
const rulings = {};
for (const [n, what] of [[0, "$150M by 2026-03-31"], [1, "$200M by 2026-03-31"]]) {
  await send("reporter", "file_claim", [pid(n)]);
  const id = `claim_${nextClaim++}`;
  const c = plain(await read(CONTRACT, "get_claim", [id]));
  rulings[pid(n)] = id;
  console.log(`  -> ${id} (${pid(n)}, UK to Sudan, ${what}): ${c.verdict} (${c.code}) ${c.why}`);
}
await send("reporter", "settle", [rulings[pid(0)]]); // the reporter accepts the no-payout ruling at once: stake credited back
await send("pledger", "settle", [rulings[pid(1)]]); // the pledger concedes the confirmed gap at once
await reconcile("both claims settled, every share credited");
for (const who of ["beneficiary", "reporter", "pledger"]) await send(who, "withdraw", []);
await reconcile("end of run, after the withdrawals");

const out = { network: "bradbury", contract: CONTRACT, accounts: Object.fromEntries(Object.entries(wallets).map(([k, a]) => [k, a.address])),
  pledges: {}, claims: {}, reconciliations, log };
for (const n of [0, 1]) {
  out.pledges[pid(n)] = plain(await read(CONTRACT, "get_pledge", [pid(n)]));
  out.claims[rulings[pid(n)]] = plain(await read(CONTRACT, "get_claim", [rulings[pid(n)]]));
}
mkdirSync(new URL("../docs/bradbury/", import.meta.url), { recursive: true });
writeFileSync(new URL("../docs/bradbury/demo-run.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("wrote docs/bradbury/demo-run.json");
