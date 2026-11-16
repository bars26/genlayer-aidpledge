// Live end-to-end demo of AidPledge v2 on GenLayer Studio, using real records from OCHA's Financial Tracking
// Service (FTS), the donor's own IATI reports (read through d-portal) and a real public announcement on GOV.UK.
//
//   node scripts/demo.mjs <contract-address>      # writes docs/demo-run.json
//
// The pledges are DEMO pledges made by a test wallet, not by any government. Their targets are demo terms chosen to
// show each ruling; a "shortfall" here means the demo pledge's own target was not met, not a finding about any donor.

import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { writeFileSync } from "fs";

const [CONTRACT] = process.argv.slice(2);
if (!CONTRACT) {
  console.error("usage: node scripts/demo.mjs <contract-address>");
  process.exit(1);
}
const RPC = "https://studio.genlayer.com/api";
const GEN = 10n ** 18n;
const WINDOW_MS = 600_000;

function client(account) {
  return createClient({ chain: studionet, endpoint: RPC, account });
}

async function rpc(method, params) {
  // Studio sometimes answers with an HTML error page; these calls are reads or idempotent top-ups, so retry them.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await res.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    } catch (err) {
      if (attempt >= 5 || /^\w+: /.test(String(err?.message))) throw err;
      await new Promise((r) => setTimeout(r, 10000 * attempt));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const TRANSIENT = /rate limit|Unexpected token '<'|not valid JSON|fetch failed|ECONNRESET|socket hang up|50[234]/i;

async function write(c, who, functionName, args, value = 0n, { expectError = false } = {}) {
  const from = c.account.address;
  for (let attempt = 1; ; attempt++) {
    const nonceBefore = BigInt(await rpc("eth_getTransactionCount", [from, "latest"]));
    try {
      let hash;
      try {
        hash = await c.writeContract({ address: CONTRACT, functionName, args, value });
      } catch (err) {
        // The RPC sometimes answers a send with an HTML error page. Only resend if the
        // nonce did not move; otherwise the first send went through and we pick it up.
        if (!TRANSIENT.test(String(err?.message || err))) throw err;
        await sleep(15000);
        const nonceAfter = BigInt(await rpc("eth_getTransactionCount", [from, "latest"]));
        if (nonceAfter === nonceBefore) throw err;
        const txs = await rpc("sim_getTransactionsForAddress", [from]);
        hash = txs.filter((t) => (t.from_address || "").toLowerCase() === from.toLowerCase()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0].hash;
        console.log(`  send answered with an error page but the tx exists: ${hash}`);
      }
      // Once a hash exists, only the wait is retried; the transaction is never sent twice.
      let receipt;
      for (let wait = 1; ; wait++) {
        try {
          receipt = await c.waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 60, interval: 5000 });
          break;
        } catch (err) {
          if (!TRANSIENT.test(String(err?.message || err)) || wait >= 6) throw Object.assign(err, { sent: true });
          await sleep(10000 * wait);
        }
      }
      // A receipt can be ACCEPTED while leaders are still rotating: wait until the last round is Accepted or Undetermined.
      let rounds = receipt?.consensus_history?.consensus_results ?? [];
      for (let poll = 0; rounds.length && !["Accepted", "Undetermined"].includes(rounds.at(-1)?.consensus_round) && poll < 60; poll++) {
        await sleep(5000);
        try { rounds = (await c.getTransaction({ hash }))?.consensus_history?.consensus_results ?? rounds; } catch {}
      }
      const lr = receipt?.consensus_data?.leader_receipt;
      const first = Array.isArray(lr) ? lr[0] : lr;
      const exec = rounds.length && rounds.at(-1)?.consensus_round === "Undetermined" ? "UNDETERMINED" : first?.execution_result ?? "?";
      let returned = first?.result?.payload?.readable;
      try { returned = JSON.parse(returned); } catch {}
      const row = {
        who,
        call: `${functionName}(${args.map((a) => (typeof a === "bigint" ? `${Number(a) / 1e18} GEN` : JSON.stringify(a)).slice(0, 60)).join(", ")})`,
        value: (Number(value) / 1e18).toString(),
        hash,
        status: receipt.statusName ?? receipt.status_name ?? "ACCEPTED",
        exec,
        returned: typeof returned === "string" ? returned : undefined,
      };
      log.push(row);
      console.log(`${row.who.padEnd(11)} ${row.call.padEnd(58)} ${row.status.padEnd(9)} ${row.exec.padEnd(7)} ${hash}${row.returned ? "  -> " + row.returned.slice(0, 160) : ""}`);
      if (expectError) {
        if (exec !== "ERROR") throw new Error(`${functionName} was expected to be refused but executed with ${exec}`);
        const msg = typeof first?.result?.payload === "string" ? first.result.payload : "";
        row.refused = msg;
        console.log(`  -> refused as designed: ${msg}`);
        return row;
      }
      if (exec !== "SUCCESS") throw new Error(`${functionName} executed with ${exec}`);
      return row;
    } catch (err) {
      const msg = String(err?.message || err);
      if (TRANSIENT.test(msg) && attempt < 5 && !err?.sent) {
        console.log(`  transient RPC error (${msg.slice(0, 60)}), waiting ${15 * attempt}s`);
        await sleep(15000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

async function read(c, functionName, args = []) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await c.readContract({ address: CONTRACT, functionName, args });
    } catch (err) {
      if (TRANSIENT.test(String(err?.message)) && attempt < 6) {
        await sleep(15000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

const balance = async (addr) => BigInt(await rpc("eth_getBalance", [addr, "latest"]));
const fmt = (wei) => (Number(wei) / 1e18).toFixed(2);
const fund = async (addr, gen) => rpc("sim_fundAccount", [addr, Number(gen * GEN)]);
const field = (obj, name) => (obj instanceof Map ? obj.get(name) : obj[name]);


const keys = { pledger: generatePrivateKey(), reporter: generatePrivateKey(), fund: generatePrivateKey(), bystander: generatePrivateKey() };
const acct = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, createAccount(v)]));
const P = client(acct.pledger);
const R = client(acct.reporter);
const F = client(acct.fund);
const B = client(acct.bystander);
if (process.env.DEMO_KEYS) writeFileSync(process.env.DEMO_KEYS, JSON.stringify(keys));

console.log("contract  ", CONTRACT);
for (const [k, a] of Object.entries(acct)) console.log(k.padEnd(10), a.address);
await fund(acct.pledger.address, 100n);
await fund(acct.reporter.address, 20n);
await fund(acct.fund.address, 1n);
await fund(acct.bystander.address, 1n);
await sleep(3000);

const firstPledge = (await read(P, "get_pledges", [0, 200])).length;
let nextClaim = (await read(P, "get_claims", [0, 200])).length;
const pid = (n) => `pledge_${firstPledge + n}`;
const ruling = async (claimId, label) => {
  const c = await read(P, "get_claim", [claimId]);
  console.log(`  -> ${label}: ${field(c, "verdict")} (${field(c, "code")}) ${field(c, "why")}`);
  return field(c, "verdict");
};
const file = async (who, c, pledgeId, label) => {
  await write(c, who, "file_claim", [pledgeId]);
  const claimId = `claim_${nextClaim++}`;
  await ruling(claimId, label);
  return claimId;
};
const claims = [];

// GEN leaves the contract only through withdraw(); its transfer runs once the withdraw is finalized, so compare
// balances only when nothing touching the contract is in flight.
const quiet = async () => {
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const txs = await rpc("sim_getTransactionsForAddress", [CONTRACT]);
    const busy = txs.filter((t) => t.status !== "FINALIZED" && t.status !== "CANCELED" && t.status !== "UNDETERMINED").length;
    if (busy === 0 && txs.length === last) return txs.length;
    last = busy === 0 ? txs.length : -1;
    await sleep(10000);
  }
  throw new Error("transactions did not finalize");
};
const reconciliations = [];
const reconcile = async (label) => {
  await quiet();
  const t = JSON.parse(await read(P, "totals"));
  const onChain = await balance(CONTRACT);
  const ok = BigInt(t.expected_balance) === onChain;
  reconciliations.push({ label, bonds: t.bonds, pending_stakes: t.pending_stakes, owed: t.owed, expected: t.expected_balance, balance: onChain.toString(), ok });
  console.log(`  reconcile (${label}): bonds ${fmt(t.bonds)} + open stakes ${fmt(t.pending_stakes)} + credited ${fmt(t.owed)} = ${fmt(t.expected_balance)} GEN; contract balance ${fmt(onChain)} GEN ${ok ? "OK" : "MISMATCH"}`);
  if (!ok) throw new Error("balance mismatch");
};
const coverages = {};

const UK = "2917"; // United Kingdom, Government of
const FCDO = "GB-GOV-1"; // UK Foreign, Commonwealth & Development Office, the UK's IATI publisher for humanitarian aid
const WFP = "XM-DAC-41140"; // World Food Programme: a real IATI publisher, but not the UK
const GERMANY = "4306"; // Germany, Government of
const SUDAN = "1220"; // Sudan Humanitarian Needs and Response Plan 2025
const ANNOUNCEMENT = "https://www.gov.uk/government/news/uk-announces-new-humanitarian-funding-for-sudan"; // 15 April 2025, GBP 120M
const ECHO = "8523"; // European Commission's DG ECHO: 182 flows to the Sudan plan, two FTS pages
const ECHO_ANNOUNCEMENT = "https://north-africa-middle-east-gulf.ec.europa.eu/news/eu-announces-eu2825-million-humanitarian-aid-chad-and-sudan-crisis-2025-04-10_en";
const UNTIL = "2027-03-31";
const pledge = (target, by, payout, bond, { donor = UK, plan = SUDAN, url = ANNOUNCEMENT, iati = FCDO, until = UNTIL, refused = false } = {}) =>
  write(P, "pledger", "create_pledge", [donor, plan, target, by, url, payout, acct.fund.address, until, iati, bond], 0n, { expectError: refused });

// The pledger deposits once; every bond is taken from that credit after the validators agree on the pledge.
await write(P, "pledger", "deposit", [], 15n * GEN); // 14 GEN of bonds below, 1 GEN left to withdraw at the end
// Refused at pledging: nothing is taken from the deposit.
await pledge(150_000_000, "2026-03-31", 2n * GEN, 2n * GEN, { donor: "UK", refused: true }); // not an FTS organization id
await pledge(150_000_000, "2026-03-31", 4n * GEN, 2n * GEN, { refused: true }); // bond below the payout
await pledge(150_000_000, "2026-03-31", 20n * GEN, 20n * GEN, { refused: true }); // more than the deposit
await pledge(150_000_000, "2026-02-31", 2n * GEN, 2n * GEN, { refused: true }); // no such calendar date
await pledge(150_000_000, "2026-03-31", 2n * GEN, 2n * GEN, { plan: "999999", refused: true }); // FTS has no such plan
await pledge(150_000_000, "2026-03-31", 2n * GEN, 2n * GEN, { donor: GERMANY, refused: true }); // a UK announcement cited for Germany
await pledge(150_000_000, "2026-03-31", 2n * GEN, 2n * GEN, { iati: WFP, refused: true }); // the WFP's IATI file cited as the UK's
await reconcile("after the refused pledges: the whole deposit is still credited");

// P0: UK to the Sudan plan, at least $150M by 2026-03-31, with the FCDO's IATI reports as the second source.
// FTS records ~$141.1M (short), the UK's own IATI reports ~$160.7M of humanitarian disbursements to Sudan: they disagree.
console.log("");
await pledge(150_000_000, "2026-03-31", 4n * GEN, 4n * GEN);
await write(R, "reporter", "deposit", [], 3n * GEN);
claims.push(await file("reporter", R, pid(0), "P0 UK to Sudan, $150M by 2026-03-31, FTS + IATI"));
const c0 = claims.at(-1);
coverages[`${pid(0)} with an open claim`] = JSON.parse(await read(P, "coverage", [pid(0)]));
await reconcile("claim open on P0");
await write(P, "pledger", "settle", [c0], 0n, { expectError: true }); // only the claimant may accept early
await write(R, "reporter", "contest", [c0]); // the reporter asks for a fresh reading of both sources
await ruling(c0, "P0 after the reporter's contest");
await write(R, "reporter", "settle", [c0]); // and accepts: the stake is credited back, no payout

// P1: the same terms with a $200M target: both sources show a gap, and only the smaller one (IATI's) is paid.
console.log("");
await pledge(200_000_000, "2026-03-31", 4n * GEN, 4n * GEN);
claims.push(await file("reporter", R, pid(1), "P1 UK to Sudan, $200M by 2026-03-31, FTS + IATI"));
const c1 = claims.at(-1);
await write(R, "reporter", "settle", [c1], 0n, { expectError: true }); // the reporter gains from a payout: cannot settle early
await write(F, "fund", "settle", [c1], 0n, { expectError: true }); // nor can the beneficiary
await write(P, "pledger", "contest", [c1]); // the pledger asks for a fresh reading
await ruling(c1, "P1 after the pledger's contest");

// P2: $140M: met on FTS alone (IATI is not needed).
console.log("");
await pledge(140_000_000, "2026-03-31", 2n * GEN, 2n * GEN);
claims.push(await file("reporter", R, pid(2), "P2 UK to Sudan, $140M by 2026-03-31"));
await write(R, "reporter", "settle", [claims.at(-1)]); // the reporter accepts: the stake joins the bond
await write(R, "reporter", "file_claim", [pid(2)], 0n, { expectError: true }); // ruled and settled

// P3: $150M by 2026-03-31 on FTS alone (no IATI publisher given): the v1 rule, a 5.94% shortfall, conceded at once.
console.log("");
await pledge(150_000_000, "2026-03-31", 2n * GEN, 2n * GEN, { iati: "" });
claims.push(await file("reporter", R, pid(3), "P3 UK to Sudan, $150M by 2026-03-31, FTS only"));
await write(P, "pledger", "settle", [claims.at(-1)]); // the pledger concedes inside the window

// P4: ECHO to the Sudan plan, $120M by 2026-03-31 on FTS alone: 182 flows on two FTS pages add up to ~$123.8M (met).
console.log("");
await pledge(120_000_000, "2026-03-31", 2n * GEN, 2n * GEN, { donor: ECHO, url: ECHO_ANNOUNCEMENT, iati: "" });
claims.push(await file("reporter", R, pid(4), "P4 ECHO to Sudan, $120M by 2026-03-31 (two FTS pages)"));
await write(R, "reporter", "settle", [claims.at(-1)]);
await reconcile("before the response window closes");

// After the response window, anyone settles P1's shortfall; every share is credited, and each party withdraws.
console.log("\nwaiting 10 minutes for the response window...");
await write(B, "bystander", "settle", [c1], 0n, { expectError: true });
await sleep(630_000);
await write(B, "bystander", "settle", [c1]);
coverages[`${pid(1)} after settling`] = JSON.parse(await read(P, "coverage", [pid(1)]));
await write(P, "pledger", "release_bond", [pid(1)], 0n, { expectError: true }); // locked until the pledge expires
await reconcile("all claims settled, every share credited");
const credited = {};
for (const [k, a] of Object.entries(acct)) credited[k] = await read(P, "owed_to", [a.address.toLowerCase()]);
console.log("  credited:", JSON.stringify(credited));
await write(F, "fund", "withdraw", []);
await write(R, "reporter", "withdraw", []);
await write(P, "pledger", "withdraw", []);
await write(P, "pledger", "withdraw", [], 0n, { expectError: true }); // nothing left
await reconcile("end of run, after the withdrawals");

const N = 5;
console.log("\nfinal pledges:");
for (let n = 0; n < N; n++) {
  const p = await read(P, "get_pledge", [pid(n)]);
  console.log(`  ${pid(n)} ${field(p, "donor_name")} -> plan ${field(p, "plan_id")} $${Number(field(p, "target_usd")).toLocaleString("en-US")} by ${field(p, "deadline")} iati=${field(p, "iati_ref") || "-"} bond=${fmt(field(p, "bond")).padStart(6)} paid=${fmt(field(p, "total_paid"))} outcome=${field(p, "outcome") || "-"}`);
}
const evidence = {};
for (const id of claims) {
  console.log(`  explain_claim(${id}) = ${await read(P, "explain_claim", [id])}`);
  const c = await read(P, "get_claim", [id]);
  const packets = JSON.parse(field(c, "evidence_json"));
  evidence[id] = { timeline: JSON.parse(field(c, "timeline_json")), packets: packets.map((e) => ({ packet_sha256: e.packet_sha256, flows_sha256: e.flows_sha256, flows_total: e.flows_total, pages_read: e.pages_read, read_at: e.read_at, source: e.source, iati_source: e.iati_source })) };
}
const announcement = JSON.parse(field(await read(P, "get_pledge", [pid(0)]), "announcement_json"));
const out = { contract: CONTRACT, accounts: Object.fromEntries(Object.entries(acct).map(([k, a]) => [k, a.address])), pledges: [...Array(N).keys()].map(pid), claims, announcement, coverages, credited, reconciliations, evidence, log };
writeFileSync(new URL("../docs/demo-run.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("\nwrote docs/demo-run.json");
