import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { createClient as createBradburyClient, encodeExternalMessageFeeParams } from "genlayer-js-bradbury";
import { testnetBradbury } from "genlayer-js-bradbury/chains";
import type { Network } from "../network";
import type { Claim, Pledge } from "./types";
import { TxError, classifyError, rawMessage } from "../utils/errors";
import { withBackoff } from "../utils/retry";
import { takeSlot } from "../utils/rateBudget";

export type TxStep = "awaiting_wallet" | "submitted" | "retrying" | "accepted";

export interface TxProgress {
  step: TxStep;
  txHash?: string;
  message?: string;
}

export interface TxResult {
  txHash: string;
  status: string;
  executionResult: string;
  receipt: any;
  /** The contract method's return value (pledge id, claim id, verdict, outcome, ...). */
  returned?: unknown;
}

/**
 * Pull the contract-execution outcome out of a consensus receipt.
 *   result.status "rollback" -> the contract raised; payload is its message.
 *   result.status "return"   -> payload.readable is the JSON-encoded return value.
 */
export function executionOutcome(receipt: any): { result: string; message: string; returned: unknown } {
  const lr = receipt?.consensus_data?.leader_receipt;
  const first = Array.isArray(lr) ? lr[0] : lr;
  const result = String(first?.execution_result ?? receipt?.execution_result ?? "UNKNOWN");
  const r = first?.result ?? {};
  let returned: unknown = undefined;
  if (r?.status === "return") {
    const readable = r?.payload?.readable;
    try {
      returned = typeof readable === "string" ? JSON.parse(readable) : readable;
    } catch {
      returned = readable;
    }
  }
  const g = first?.genvm_result ?? {};
  const message = [
    r?.status === "rollback" && typeof r?.payload === "string" ? r.payload : "",
    g.error_description,
    typeof g.stderr === "string" ? (g.stderr.match(/UserError[^\n]*/)?.[0] ?? "") : "",
    Array.isArray(g.raw_error?.causes) ? g.raw_error.causes.join(",") : "",
  ]
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .join(" | ");
  return { result, message, returned };
}

const WRITE_EFFECT: Record<string, string> = {
  deposit: "nothing was credited",
  create_pledge: "no pledge was created (the deposit stays credited)",
  add_bond: "the bond was not changed",
  file_claim: "no claim was recorded (the stake stays credited; validators may have failed to read OCHA FTS or IATI, or to agree)",
  contest: "the contest was not recorded",
  settle: "nothing was settled",
  release_bond: "the bond was not released",
  withdraw: "nothing was sent",
};
const READS = new Set(["create_pledge", "file_claim", "contest"]);

// Bradbury: time each validator phase may take (seconds, 30 to 600) and the fee prepaid for a withdraw's transfer.
const BRADBURY_TIME = { create_pledge: 240n, file_claim: 300n, contest: 300n } as Record<string, bigint>;
const WITHDRAW_GAS = 100_000n;
const WITHDRAW_GAS_PRICE = 2_000_000_000n;

export interface CreatePledgeInput {
  donorId: string;
  planId: string;
  targetUsd: number;
  deadline: string;
  announcementUrl: string;
  payout: bigint;
  beneficiary: string;
  expires: string;
  /** The donor's IATI publisher id (second source), or "" to rule on OCHA FTS alone. */
  iatiRef: string;
}

/**
 * Typed wrapper around the AidPledge Intelligent Contract, on GenLayer Studio (genlayer-js 1.x) or Bradbury testnet
 * (genlayer-js 2.0 rc: fee distributions on every write, reads through a GenLayer node RPC, no return values or contract
 * messages in what the chain reports, so results are read back from the contract after each write).
 */
class AidPledge {
  readonly network: Network;
  private contractAddress: `0x${string}`;
  private account?: `0x${string}`;
  private client: any;
  private reader: any;

  constructor(network: Network, address?: string | null) {
    this.network = network;
    this.contractAddress = network.contract as `0x${string}`;
    this.account = (address || undefined) as `0x${string}` | undefined;
    if (network.id === "bradbury") {
      this.client = createBradburyClient({ chain: testnetBradbury, ...(address ? { account: address as `0x${string}` } : {}) } as any);
      this.reader = createBradburyClient({ chain: testnetBradbury, endpoint: network.readRpc } as any);
    } else {
      const config: any = { chain: studionet, endpoint: network.rpc };
      if (address) config.account = address as `0x${string}`;
      this.client = createClient(config);
      this.reader = this.client;
    }
  }

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    // On Studio every attempt is a gen_call, so each one draws on the client-side rate budget.
    return withBackoff(
      async () => {
        if (this.network.rateLimited) await takeSlot();
        return (await this.reader.readContract({ address: this.contractAddress, functionName, args })) as T;
      },
      { phase: "read", attempts: 5 }
    );
  }

  owedTo = (address: string) => this.read<string>("owed_to", [address.toLowerCase()]).then((v) => BigInt(String(v ?? "0")));
  getPledge = (id: string) => this.read<Pledge>("get_pledge", [id]);
  getClaim = (id: string) => this.read<Claim>("get_claim", [id]);
  /** The whole registry in one contract call each (pages of 200). */
  getPledges = (offset = 0, limit = 200) => this.read<Pledge[]>("get_pledges", [offset, limit]).then((v) => (Array.isArray(v) ? v : []));
  getClaims = (offset = 0, limit = 200) => this.read<Claim[]>("get_claims", [offset, limit]).then((v) => (Array.isArray(v) ? v : []));

  async getTransactionStatus(txHash: string): Promise<string> {
    const tx: any = await withBackoff(() => this.client.getTransaction({ hash: txHash as `0x${string}` }), { phase: "read" });
    return String(tx?.statusName ?? tx?.status_name ?? tx?.status ?? "UNKNOWN");
  }

  deposit(valueWei: bigint, onProgress?: (p: TxProgress) => void) {
    return this.write("deposit", [], valueWei, onProgress);
  }
  /** Bonded from the caller's credit: deposit `bondWei` first (create_pledge itself sends no GEN). */
  createPledge(p: CreatePledgeInput, bondWei: bigint, onProgress?: (p: TxProgress) => void) {
    return this.write(
      "create_pledge",
      [p.donorId, p.planId, BigInt(p.targetUsd), p.deadline, p.announcementUrl, p.payout, p.beneficiary, p.expires, p.iatiRef, bondWei],
      0n,
      onProgress
    );
  }
  addBond(id: string, valueWei: bigint, onProgress?: (p: TxProgress) => void) {
    return this.write("add_bond", [id], valueWei, onProgress);
  }
  /** The stake comes from the caller's credit (file_claim itself sends no GEN). */
  fileClaim(id: string, onProgress?: (p: TxProgress) => void) {
    return this.write("file_claim", [id], 0n, onProgress);
  }
  contest(claimId: string, onProgress?: (p: TxProgress) => void) {
    return this.write("contest", [claimId], 0n, onProgress);
  }
  settle(claimId: string, onProgress?: (p: TxProgress) => void) {
    return this.write("settle", [claimId], 0n, onProgress);
  }
  releaseBond(id: string, onProgress?: (p: TxProgress) => void) {
    return this.write("release_bond", [id], 0n, onProgress);
  }
  withdraw(onProgress?: (p: TxProgress) => void) {
    return this.write("withdraw", [], 0n, onProgress);
  }

  /**
   * Send a write and wait for consensus. Sends are never auto-retried (each attempt would
   * prompt the wallet again); receipt polling is, because the hash is already known.
   * A call the contract reverted is still ACCEPTED by consensus, so the receipt's
   * execution_result is checked and a revert is reported as such.
   */
  private async write(functionName: string, args: unknown[], value: bigint, onProgress?: (p: TxProgress) => void): Promise<TxResult> {
    if (this.network.id === "bradbury") return this.writeBradbury(functionName, args, value, onProgress);
    await takeSlot((ms) =>
      onProgress?.({ step: "retrying", message: `Waiting ${Math.ceil(ms / 1000)}s to stay under GenLayer Studio's 30 requests per minute.` })
    );
    onProgress?.({ step: "awaiting_wallet", message: "Approve the transaction in your wallet." });
    let txHash: string;
    try {
      txHash = (await this.client.writeContract({ address: this.contractAddress, functionName, args, value })) as string;
    } catch (err) {
      throw classifyError(err, "send");
    }
    const reading = READS.has(functionName)
      ? "Validators are reading OCHA FTS and the donor's IATI reports (1 to 3 minutes)."
      : "Waiting for consensus.";
    onProgress?.({ step: "submitted", txHash, message: `Transaction sent. ${reading}` });

    let receipt: any;
    try {
      receipt = await withBackoff(
        () => this.client.waitForTransactionReceipt({ hash: txHash, status: "ACCEPTED" as any, retries: 72, interval: 5000 }),
        {
          phase: "confirm",
          onRetry: (i) => onProgress?.({ step: "retrying", txHash, message: `RPC busy while confirming; retrying in ${Math.round(i.waitMs / 1000)}s` }),
        }
      );
    } catch (err) {
      throw classifyError(err, "confirm", txHash);
    }

    const status = String(receipt?.statusName ?? receipt?.status_name ?? "ACCEPTED");
    const outcome = executionOutcome(receipt);
    // After rotating leaders without agreeing, a round ends "Undetermined": the leader's result is in the receipt, but
    // nothing was applied.
    // A receipt can read ACCEPTED while leaders are still rotating: wait until the last round is final.
    let rounds: any[] = receipt?.consensus_history?.consensus_results ?? [];
    for (let poll = 0; rounds.length && !["Accepted", "Undetermined"].includes(rounds.at(-1)?.consensus_round) && poll < 60; poll++) {
      onProgress?.({ step: "submitted", txHash, message: "Validators are still deciding (a new leader is taking over)." });
      await new Promise((r) => setTimeout(r, 5000));
      try {
        rounds = ((await this.client.getTransaction({ hash: txHash as any })) as any)?.consensus_history?.consensus_results ?? rounds;
      } catch {
        // keep the last rounds we saw
      }
    }
    if (rounds.length && rounds.at(-1)?.consensus_round === "Undetermined") {
      throw new TxError({
        kind: "accepted_no_effect",
        phase: "verify",
        txHash,
        message: `The validators could not agree, so ${WRITE_EFFECT[functionName] ?? "nothing changed"}.`,
        hint: "Nothing was applied and any stake stays credited to you. Nothing was applied; send it again (the deposit stays credited).",
        detail: rounds.map((r: any) => r?.consensus_round).join(" → "),
      });
    }
    onProgress?.({ step: "accepted", txHash, message: `Consensus status: ${status}` });
    // Payable methods refuse by refunding and returning "REFUNDED: <reason>" instead of reverting,
    // because GenLayer keeps a reverted call's value in the contract.
    if (typeof outcome.returned === "string" && outcome.returned.startsWith("REFUNDED:")) {
      throw new TxError({
        kind: "contract_revert",
        phase: "verify",
        txHash,
        message: `The contract refused this call and credited your GEN back: ${outcome.returned.slice(9).trim()}`,
        hint: "Nothing else changed. Take the GEN out with Withdraw under “Your GEN in AidPledge”.",
        detail: String(outcome.returned),
      });
    }
    if (outcome.result === "ERROR") {
      throw new TxError({
        kind: "accepted_no_effect",
        phase: "verify",
        txHash,
        message: `The transaction was ACCEPTED, but the contract rejected the call, so ${WRITE_EFFECT[functionName] ?? "nothing changed"}.`,
        hint: outcome.message ? `Contract message: ${outcome.message}` : "Open the transaction in the explorer for details.",
        detail: outcome.message || rawMessage(receipt?.result) || "execution_result: ERROR",
      });
    }
    return { txHash, status, executionResult: outcome.result, receipt, returned: outcome.returned };
  }

  /** Fee options for a Bradbury write; a withdraw also prepays the fee of the transfer it sends to the caller. */
  private async bradburyFees(functionName: string) {
    const time = BRADBURY_TIME[functionName] ?? 120n;
    const messageAllocations =
      functionName === "withdraw" && this.account
        ? [{ messageType: 0, onAcceptance: false, recipient: this.account, callKey: `0x${"00".repeat(32)}`,
             feeParams: encodeExternalMessageFeeParams({ gasLimit: WITHDRAW_GAS, maxGasPrice: WITHDRAW_GAS_PRICE }),
             budget: WITHDRAW_GAS * WITHDRAW_GAS_PRICE }]
        : undefined;
    const est = await this.client.estimateTransactionFees({ leaderTimeunitsAllocation: time, validatorTimeunitsAllocation: time, messageAllocations });
    return { distribution: est.distribution, feeValue: est.feeValue, ...(messageAllocations ? { messageAllocations: est.messageAllocations ?? messageAllocations } : {}) };
  }

  /**
   * Bradbury: the chain reports the consensus decision and whether the contract ran to completion, but not its return
   * value or message. A refused payable call still completes (it returns "REFUNDED: ..." and credits the GEN back), so
   * callers check what changed by reading the contract afterwards.
   */
  private async writeBradbury(functionName: string, args: unknown[], value: bigint, onProgress?: (p: TxProgress) => void): Promise<TxResult> {
    let fees: any;
    try {
      fees = await this.bradburyFees(functionName);
    } catch (err) {
      throw classifyError(err, "estimate");
    }
    onProgress?.({ step: "awaiting_wallet", message: "Approve the transaction in your wallet." });
    let txHash: string;
    try {
      txHash = (await this.client.writeContract({ address: this.contractAddress, functionName, args, value, fees })) as string;
    } catch (err) {
      throw classifyError(err, "send");
    }
    const reading = READS.has(functionName)
      ? "Five Bradbury validators are reading OCHA FTS and IATI (1 to 5 minutes)."
      : "Waiting for Bradbury validators to decide (about a minute).";
    onProgress?.({ step: "submitted", txHash, message: `Transaction sent. ${reading}` });

    let tx: any;
    try {
      tx = await withBackoff(
        async () => {
          await this.client.waitForTransactionReceipt({ hash: txHash, status: "ACCEPTED" as any, retries: 100, interval: 6000 }).catch(() => null);
          return this.client.getTransaction({ hash: txHash as `0x${string}` });
        },
        { phase: "confirm" }
      );
    } catch (err) {
      throw classifyError(err, "confirm", txHash);
    }
    const status = String(tx?.statusName ?? "UNKNOWN");
    const execution = String(tx?.txExecutionResultName ?? "UNKNOWN");
    onProgress?.({ step: "accepted", txHash, message: `Consensus status: ${status}` });
    if (status !== "ACCEPTED" && status !== "FINALIZED") {
      throw new TxError({
        kind: "accepted_no_effect",
        phase: "verify",
        txHash,
        message: `The validators did not reach a decision (${status.replaceAll("_", " ").toLowerCase()}), so ${WRITE_EFFECT[functionName] ?? "nothing changed"}.`,
        hint: "This happens on the testnet when a leader runs out of time. Nothing was charged beyond the fee; send it again.",
        detail: `status ${status}, execution ${execution}`,
      });
    }
    if (execution !== "FINISHED_WITH_RETURN") {
      throw new TxError({
        kind: "accepted_no_effect",
        phase: "verify",
        txHash,
        message: `The transaction was ACCEPTED, but the contract rejected the call, so ${WRITE_EFFECT[functionName] ?? "nothing changed"}.`,
        hint: "Bradbury does not report the contract's message; the app checks the usual reasons before sending. Open the transaction in the explorer.",
        detail: `execution ${execution}; votes ${(tx?.lastRound?.validatorVotesName ?? []).join("/")}`,
      });
    }
    return { txHash, status, executionResult: execution, receipt: tx, returned: undefined };
  }
}

export default AidPledge;
