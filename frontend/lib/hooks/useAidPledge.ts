"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import AidPledge, { type CreatePledgeInput, type TxProgress, type TxResult } from "../contracts/AidPledge";
import { claimsOpen, formatGen, parseJson, sameAddress, stakeFor, todayUtc, windowLeftSeconds, wei, VERDICT_STYLE, type Claim, type Pledge, type Verdict } from "../contracts/types";
import { isOnGenLayerNetwork, switchToGenLayerNetwork } from "../genlayer/client";
import { useWallet } from "../genlayer/wallet";
import { currentNetwork } from "../network";
import { TxError, classifyError } from "../utils/errors";
import { error, success } from "../utils/toast";
import { startTx, updateTx, type TxKind } from "./useTxLog";

export function usePledgeContract(): AidPledge | null {
  const { address } = useWallet();
  const network = currentNetwork();
  return useMemo(() => (/^0x[0-9a-fA-F]{40}$/.test(network.contract) ? new AidPledge(network, address) : null), [network, address]);
}

const registryKey = () => ["registry", currentNetwork().id];

type Registry = { pledges: Pledge[]; claims: Claim[]; fetchedAt?: string };

async function fetchJson(url: string, timeoutMs = 60_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

/**
 * Every pledge and claim, from the CDN-cached server snapshot (app/api/registry), so page
 * loads spend none of the visitor's Studio rate-limit budget. Falls back to two direct reads.
 */
export function useRegistry() {
  const contract = usePledgeContract();
  const query = useQuery<Registry, Error>({
    queryKey: registryKey(),
    queryFn: async () => {
      try {
        const body = await fetchJson(`/api/registry?network=${currentNetwork().id}`);
        if (!Array.isArray(body.pledges) || !Array.isArray(body.claims)) throw new Error("Malformed snapshot");
        return body as Registry;
      } catch (snapshotErr) {
        if (!contract) throw classifyError(snapshotErr, "read");
        const [pledges, claims] = await Promise.all([contract.getPledges(), contract.getClaims()]);
        return { pledges, claims, fetchedAt: new Date().toISOString() };
      }
    },
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
  return {
    pledges: query.data?.pledges ?? [],
    claims: query.data?.claims ?? [],
    fetchedAt: query.data?.fetchedAt,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Re-read what a write touched and merge it into the cached registry. */
async function mergeFresh(qc: ReturnType<typeof useQueryClient>, contract: AidPledge, pledgeId?: string, claimId?: string) {
  try {
    const [pledge, claim] = await Promise.all([
      pledgeId ? contract.getPledge(pledgeId) : Promise.resolve(null),
      claimId ? contract.getClaim(claimId) : Promise.resolve(null),
    ]);
    qc.setQueryData<Registry>(registryKey(), (prev) => {
      let pledges = prev?.pledges ?? [];
      let claims = prev?.claims ?? [];
      if (pledge) pledges = pledges.some((p) => p.id === pledge.id) ? pledges.map((p) => (p.id === pledge.id ? pledge : p)) : [...pledges, pledge];
      if (claim) claims = claims.some((c) => c.id === claim.id) ? claims.map((c) => (c.id === claim.id ? claim : c)) : [...claims, claim];
      return { pledges, claims, fetchedAt: prev?.fetchedAt };
    });
  } catch {
    // Already confirmed on chain; the next snapshot refresh picks it up.
  }
}

export type WriteVars =
  | { kind: "create"; input: CreatePledgeInput; bond: bigint }
  | { kind: "bond"; pledgeId: string; value: bigint }
  | { kind: "file"; pledgeId: string }
  | { kind: "contest"; claimId: string }
  | { kind: "settle"; claimId: string }
  | { kind: "release"; pledgeId: string }
  | { kind: "withdraw" };

export const WRITE_LABEL: Record<TxKind, string> = {
  create: "Create pledge",
  bond: "Add to bond",
  file: "Report a shortfall",
  contest: "Ask for a fresh reading",
  settle: "Settle",
  release: "Release the bond",
  withdraw: "Withdraw your GEN",
};

const verdictNote = (v: unknown, c?: Claim) => {
  const s = VERDICT_STYLE[String(v) as Verdict];
  return s ? `Ruling: ${s.label}. ${c?.why ?? s.help}` : "Recorded.";
};

/** One mutation for every AidPledge write, with a transaction log entry and typed errors. */
export function usePledgeWrite() {
  const contract = usePledgeContract();
  const { address } = useWallet();
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (vars: WriteVars) => {
      const target =
        vars.kind === "withdraw"
          ? "your credited GEN"
          : vars.kind === "create"
            ? `donor ${vars.input.donorId} → plan ${vars.input.planId}`
            : "claimId" in vars
              ? vars.claimId
              : vars.pledgeId;
      const logId = startTx(vars.kind, target);
      setPending(vars.kind === "create" || vars.kind === "withdraw" ? vars.kind : `${vars.kind}:${"claimId" in vars ? vars.claimId : vars.pledgeId}`);
      const onProgress = (p: TxProgress) =>
        updateTx(logId, {
          state: p.step === "awaiting_wallet" ? "awaiting_wallet" : p.step === "accepted" ? "accepted" : "confirming",
          txHash: p.txHash,
          progress: p.message,
        });
      const refuse = (message: string): never => {
        throw new TxError({ kind: "contract_revert", phase: "estimate", message, hint: "The data was refreshed; nothing was sent." });
      };
      try {
        if (!contract) throw new TxError({ kind: "unknown", phase: "send", message: "The contract address is not configured." });
        if (!address) throw new TxError({ kind: "wallet_missing", phase: "send", message: "No wallet is connected." });
        // A wallet that was already connected keeps whatever chain it was on: ask MetaMask to switch first.
        if (!(await isOnGenLayerNetwork())) {
          try {
            await switchToGenLayerNetwork();
          } catch (err) {
            throw classifyError(err, "send");
          }
        }
        const bradbury = contract.network.id === "bradbury";
        const owedBefore = ["create", "file", "bond", "withdraw"].includes(vars.kind) ? await contract.owedTo(address) : 0n;
        // v2: bonds and stakes come from credit, so a call that needs a reading never carries GEN.
        const depositMissing = async (needed: bigint, what: string) => {
          if (owedBefore >= needed) return;
          onProgress({ step: "awaiting_wallet", message: `First, deposit the ${what}: approve it in your wallet.` });
          await contract.deposit(needed - owedBefore, onProgress);
        };

        let result: TxResult;
        let pledgeId = "pledgeId" in vars ? vars.pledgeId : undefined;
        let claimId = "claimId" in vars ? vars.claimId : undefined;
        let note = "Done.";
        // Re-read right before sending, so a stale list never sends a call the contract would refuse.
        switch (vars.kind) {
          case "create":
            await depositMissing(vars.bond, "bond");
            result = await contract.createPledge(vars.input, vars.bond, onProgress);
            if (bradbury) result.returned = (await contract.getPledges()).filter((p) => sameAddress(p.pledger, address)).at(-1)?.id;
            pledgeId = typeof result.returned === "string" ? result.returned : undefined;
            note = pledgeId ? `Pledge ${pledgeId} is live.` : "Pledge created.";
            break;
          case "bond": {
            const p = await contract.getPledge(vars.pledgeId);
            if (!sameAddress(p.pledger, address)) refuse("Only the pledger can add to this bond.");
            if (p.state !== "active") refuse("This pledge is closed.");
            result = await contract.addBond(vars.pledgeId, vars.value, onProgress);
            if (bradbury && (await contract.owedTo(address)) >= owedBefore + vars.value)
              refuse("The contract refused this top-up and credited your GEN back; withdraw it from “Your GEN in AidPledge”.");
            break;
          }
          case "file": {
            const p = await contract.getPledge(vars.pledgeId);
            if (p.state !== "active") refuse("This pledge is closed.");
            if (p.outcome) refuse(`This pledge has already been ruled and settled (${p.outcome}).`);
            if (todayUtc() < claimsOpen(p)) refuse(`Claims open on ${claimsOpen(p)}: FTS needs time to record funding dated up to ${p.deadline}.`);
            if (todayUtc() > p.expires) refuse(`This pledge expired on ${p.expires}.`);
            if (wei(p.pending) > 0n) refuse("A claim is already open for this pledge.");
            await depositMissing(stakeFor(p), "stake (10% of the payout)");
            result = await contract.fileClaim(vars.pledgeId, onProgress);
            if (bradbury) result.returned = parseJson<string[]>((await contract.getPledge(vars.pledgeId)).claim_ids_json, []).at(-1);
            claimId = typeof result.returned === "string" ? result.returned : undefined;
            if (claimId) {
              const c = await contract.getClaim(claimId);
              note = `${claimId}: ${verdictNote(c.verdict, c)}`;
            }
            break;
          }
          case "contest": {
            const c = await contract.getClaim(vars.claimId);
            const p = await contract.getPledge(c.pledge_id);
            pledgeId = p.id;
            if (c.state !== "pending") refuse("This claim is already settled.");
            if (windowLeftSeconds(c) === 0) refuse("The response window has closed; the claim can only be settled now.");
            const mine = c.verdict === "BREACHED" ? sameAddress(p.pledger, address) && !c.pledger_contested : sameAddress(c.claimant, address) && !c.claimant_contested;
            if (!mine) refuse("This ruling does not go against you, or your side has already contested it.");
            result = await contract.contest(vars.claimId, onProgress);
            const fresh = await contract.getClaim(vars.claimId);
            note = `Read again: ${verdictNote(fresh.verdict, fresh)} The response window restarted.`;
            break;
          }
          case "settle": {
            const c = await contract.getClaim(vars.claimId);
            const p = await contract.getPledge(c.pledge_id);
            pledgeId = p.id;
            if (c.state !== "pending") refuse("This claim is already settled.");
            if (windowLeftSeconds(c) > 0) {
              if (c.verdict === "BREACHED" && !sameAddress(p.pledger, address)) refuse("Until the window ends, only the pledger can concede a shortfall.");
              if (c.verdict !== "BREACHED" && !sameAddress(c.claimant, address)) refuse("Until the window ends, only the reporter can accept this ruling.");
            }
            result = await contract.settle(vars.claimId, onProgress);
            if (bradbury) result.returned = (await contract.getClaim(vars.claimId)).outcome;
            note =
              result.returned === "paid"
                ? "The shortfall was paid from the bond in proportion to the gap: 90% credited to the beneficiary, 10% plus the stake to the reporter. They take it out with Withdraw."
                : result.returned === "stake_returned"
                  ? "The reporter's stake was credited back."
                  : "The reporter's stake was added to the bond.";
            break;
          }
          case "release": {
            const p = await contract.getPledge(vars.pledgeId);
            if (p.state !== "active") refuse("The bond has already been released.");
            if (todayUtc() <= p.expires) refuse(`The bond stays locked until the pledge expires on ${p.expires}.`);
            if (wei(p.pending) > 0n) refuse("Settle the open claims first.");
            result = await contract.releaseBond(vars.pledgeId, onProgress);
            note = "The rest of the bond is credited to the pledger, who takes it out with Withdraw.";
            break;
          }
          case "withdraw":
            if (owedBefore === 0n) refuse("Nothing is credited to this wallet.");
            result = await contract.withdraw(onProgress);
            note = `${formatGen(owedBefore, 4)} GEN sent to your wallet${bradbury ? " (it arrives about a minute after the transaction finalizes)" : ""}.`;
            break;
        }
        updateTx(logId, { state: "accepted", txHash: result.txHash, status: result.status, executionResult: result.executionResult, progress: note });
        return { pledgeId, claimId, txHash: result.txHash, kind: vars.kind, note };
      } catch (err) {
        const e = classifyError(err, "send");
        if (contract) mergeFresh(qc, contract, "pledgeId" in vars ? vars.pledgeId : undefined, "claimId" in vars ? vars.claimId : undefined);
        updateTx(logId, {
          state: "failed",
          txHash: e.txHash,
          error: { kind: e.kind, message: e.message, hint: e.hint, detail: e.detail, phase: e.phase },
        });
        error(`${WRITE_LABEL[vars.kind]} failed`, { description: [e.message, e.hint].filter(Boolean).join(" "), duration: 12000 });
        throw err;
      } finally {
        setPending(null);
      }
    },
    onSuccess: ({ pledgeId, claimId, txHash, kind, note }) => {
      if (contract) mergeFresh(qc, contract, pledgeId, claimId);
      qc.invalidateQueries({ queryKey: ["genBalance"] });
      qc.invalidateQueries({ queryKey: ["owed"] });
      success(`${WRITE_LABEL[kind]} confirmed`, {
        description: `${note} Tx ${txHash.slice(0, 10)}... is ACCEPTED by validator consensus.`,
        duration: 10000,
      });
    },
  });

  return { write: mutation.mutate, writeAsync: mutation.mutateAsync, pending, isPending: mutation.isPending };
}
