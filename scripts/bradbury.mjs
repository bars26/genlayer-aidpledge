// Shared helpers for AidPledge on Bradbury testnet (Phase 2, chain 4221), with genlayer-js 2.0.0-rc.2.
//
// - Writes go through the SDK's default chain RPC; reads (gen_call) need a GenLayer node RPC, rpc-bradbury.genlayer.com.
// - Every write carries a fee distribution from estimateTransactionFees (time units are seconds, 30 to 600 per phase).
// - `withdraw` sends GEN out as an external message: the transaction must prepay that message's fee with a message
//   allocation to the recipient, or the transfer is dropped.
// - A receipt's ACCEPTED status alone says nothing about execution: `outcome` reads the execution result and votes.

import { readFileSync } from "fs";
import { createClient, createAccount, encodeExternalMessageFeeParams } from "genlayer-js-bradbury";
import { testnetBradbury } from "genlayer-js-bradbury/chains";

export const READ_RPC = "https://rpc-bradbury.genlayer.com";
export const EXPLORER = "https://explorer-bradbury.genlayer.com";
export const reader = createClient({ chain: testnetBradbury, endpoint: READ_RPC });

export const keyFile = (name) => `${process.env.HOME}/.config/genlayer-demos/${name}`;
export const accountFrom = (file) => createAccount(JSON.parse(readFileSync(file, "utf8")).privateKey);
export const clientFor = (account) => createClient({ chain: testnetBradbury, account });

const WITHDRAW_GAS = 100_000n;
const WITHDRAW_GAS_PRICE = 2_000_000_000n;

/** Fee options for a write. `payee` adds the message allocation a withdraw needs. */
export async function feesFor(client, { leader = 300n, validator = 300n, payee } = {}) {
  const messageAllocations = payee
    ? [{ messageType: 0, onAcceptance: false, recipient: payee, callKey: `0x${"00".repeat(32)}`,
         feeParams: encodeExternalMessageFeeParams({ gasLimit: WITHDRAW_GAS, maxGasPrice: WITHDRAW_GAS_PRICE }),
         budget: WITHDRAW_GAS * WITHDRAW_GAS_PRICE }]
    : undefined;
  const est = await client.estimateTransactionFees({ leaderTimeunitsAllocation: leader, validatorTimeunitsAllocation: validator, messageAllocations });
  return { distribution: est.distribution, feeValue: est.feeValue, ...(messageAllocations ? { messageAllocations: est.messageAllocations ?? messageAllocations } : {}) };
}

/** Wait for a decision and summarize it: status, execution result, the five votes, seconds. */
export async function outcome(client, hash, t0 = Date.now()) {
  await client.waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 300, interval: 6000 }).catch(() => {});
  const t = await client.getTransaction({ hash });
  const votes = (t.lastRound?.validatorVotesName || []).map((v) => v.replace("FINISHED_WITH_", ""));
  const ok = t.statusName === "ACCEPTED" && t.txExecutionResultName === "FINISHED_WITH_RETURN";
  return { ok, hash, status: t.statusName, execution: t.txExecutionResultName, votes, seconds: Math.round((Date.now() - t0) / 1000), recipient: t.recipient };
}

/** Send a write, retrying a decided-but-not-executed round (leader timeout) up to `tries` times. */
export async function write(client, address, functionName, args = [], { value = 0n, tries = 3, ...feeOpts } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    const hash = await client.writeContract({ address, functionName, args, value, fees: await feesFor(client, feeOpts) });
    last = await outcome(client, hash, t0);
    if (last.ok || last.execution === "FINISHED_WITH_ERROR") return last;
  }
  return last;
}

export const read = (address, functionName, args = []) => reader.readContract({ address, functionName, args });
export const balance = async (client, address) => client.getBalance({ address });
export const gen = (wei) => (Number(wei) / 1e18).toFixed(4);
