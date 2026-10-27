"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Megaphone } from "lucide-react";
import {
  announcementOf,
  claimsOpen,
  coverageOf,
  formatGen,
  ftsPlanUrl,
  planOf,
  sameAddress,
  shortName,
  todayUtc,
  usd,
  wei,
  type Claim,
  type FundingLookup,
  type Pledge,
} from "@/lib/contracts/types";
import { formatAddress, useWallet } from "@/lib/genlayer/wallet";
import { usePledgeWrite } from "@/lib/hooks/useAidPledge";
import { ClaimCard } from "./ClaimCard";
import { FileClaimModal } from "./FileClaimModal";
import { FundingBar } from "./FundingBar";
import { Button } from "./ui/button";

/** Live FTS funding for a pledge's donor, plan and deadline (the same reading validators make). */
export function useFunding(p: Pick<Pledge, "donor_id" | "plan_id" | "deadline">, enabled = true) {
  return useQuery<FundingLookup>({
    queryKey: ["funding", p.donor_id, p.plan_id, p.deadline],
    queryFn: async () => (await fetch(`/api/funding?donor=${p.donor_id}&plan=${p.plan_id}&by=${p.deadline}`)).json(),
    enabled,
    staleTime: 10 * 60_000,
  });
}

/** One pledge: who promised what to which crisis, how funding stands on FTS today, what it still guarantees, and its claims. */
export function PledgeCard({ pledge, claims }: { pledge: Pledge; claims: Claim[] }) {
  const { address } = useWallet();
  const { write, pending } = usePledgeWrite();
  const plan = planOf(pledge);
  const ann = announcementOf(pledge);
  const cov = coverageOf(pledge);
  const { data: live } = useFunding(pledge);
  const isPledger = sameAddress(pledge.pledger, address);
  const active = pledge.state === "active";
  const opens = claimsOpen(pledge);
  const due = todayUtc() >= opens;
  const open = claims.filter((c) => c.state === "pending");
  const done = claims.filter((c) => c.state !== "pending").reverse();
  const target = Number(pledge.target_usd);

  return (
    <article className="brand-card overflow-hidden">
      <div className="grid grid-cols-[6px_1fr]">
        <div className={pledge.outcome === "paid" ? "bg-[#C0533B]" : pledge.outcome === "kept" ? "bg-[#2E8B67]" : "bg-[#F2B33D]"} />
        <div className="p-5 md:p-6 space-y-4">
          <header className="flex flex-wrap items-start gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="mono">{pledge.id}</span>
                <span>·</span>
                <span>{plan.locations.join(", ")}</span>
                {!active && <span className="rounded-full border border-border px-2 py-0.5">closed</span>}
                {pledge.outcome && <span className="rounded-full border border-border px-2 py-0.5">{pledge.outcome === "paid" ? "shortfall paid" : "ruled delivered"}</span>}
              </div>
              <h3 className="display text-2xl leading-tight mt-1">
                {shortName(pledge.donor_name)} <span className="text-[#B07A12]">→</span> {plan.name}
              </h3>
              <p className="mt-1 text-sm">
                At least <strong>{usd(target)}</strong> committed or paid by <strong>{pledge.deadline}</strong>
              </p>
            </div>
            <div className="text-right">
              <p className="display text-3xl">
                {formatGen(pledge.bond)}
                <span className="text-sm font-sans text-muted-foreground"> GEN bonded</span>
              </p>
              <p className="text-xs text-muted-foreground">pays up to {formatGen(pledge.payout)} GEN, pro rata to any shortfall</p>
            </div>
          </header>

          <div className="rounded-xl bg-[#F4EFE2] px-4 py-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              On OCHA FTS today, dated by {pledge.deadline}
              <a href={ftsPlanUrl(pledge.plan_id)} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-0.5 hover:text-foreground">
                plan {plan.code || pledge.plan_id} <ExternalLink className="w-3 h-3" />
              </a>
            </p>
            {live?.ok ? (
              <FundingBar funded={live.funded_usd ?? 0} target={target} after={live.after_usd} />
            ) : live && !live.ok ? (
              <p className="text-sm text-muted-foreground">{live.error}</p>
            ) : (
              <div className="h-14 rounded-lg bg-[#E9E3D3]/60 animate-pulse" />
            )}
            {!due && <p className="mt-2 text-xs text-muted-foreground">Not due yet: claims open on {opens}, once FTS has had 30 days to record funding.</p>}
          </div>

          {ann && (
            <details className="group text-sm">
              <summary className="flex cursor-pointer items-center gap-2 text-muted-foreground hover:text-foreground">
                <Megaphone className="w-4 h-4 text-[#B07A12]" />
                <span>
                  The announcement it rests on: validators read it as this donor&apos;s pledge for this crisis{" "}
                  <span className="rounded bg-[#DCEFE6] px-1.5 py-0.5 text-[11px] font-semibold text-[#1E6A4E]">{ann.answer}</span>
                </span>
              </summary>
              <div className="mt-2 rounded-lg border border-border p-3 space-y-1 text-xs">
                <a href={ann.url} target="_blank" rel="noopener noreferrer" className="break-all text-[#14213D] hover:underline">
                  {ann.url}
                </a>
                <p className="text-muted-foreground">“{ann.excerpt.slice(0, 320)}{ann.excerpt.length > 320 ? "…" : ""}”</p>
                <p className="mono text-muted-foreground">
                  text sha256 {ann.sha256.slice(0, 20)}… · {ann.chars} characters read
                </p>
              </div>
            </details>
          )}

          {active && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div className="rounded-lg border border-border px-3 py-2">
                <p className="text-muted-foreground">Still guaranteed</p>
                <p className="font-medium">{cov.liability > 0n ? `up to ${formatGen(cov.liability)} GEN` : "nothing: the pledge is ruled"}</p>
                <p className={cov.covered ? "text-[#1E6A4E]" : "text-[#9A3220]"}>
                  bond {formatGen(pledge.bond)} GEN: {cov.covered ? "a shortfall is always paid in full" : "under-covered"}
                </p>
              </div>
              <div className="rounded-lg border border-border px-3 py-2">
                <p className="text-muted-foreground">Claims</p>
                <p className="font-medium">{due ? `open until ${pledge.expires}` : `open from ${opens}`}</p>
                <p className="text-muted-foreground">anyone can report, staking 10% of the payout</p>
              </div>
              <div className="rounded-lg border border-border px-3 py-2">
                <p className="text-muted-foreground">Bond locked</p>
                <p className="font-medium">until {pledge.expires}</p>
                <p className="text-muted-foreground">and until every claim is settled</p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>paid out <strong className="text-foreground">{formatGen(pledge.total_paid)} GEN</strong></span>
            {wei(pledge.stakes_kept) > 0n && <span>stakes kept {formatGen(pledge.stakes_kept)} GEN</span>}
            <span>
              pledger <span className="mono">{formatAddress(pledge.pledger)}</span>
              {isPledger && " (you)"}
            </span>
            <span>
              beneficiary <span className="mono">{formatAddress(pledge.beneficiary)}</span>
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {active && !pledge.outcome && <FileClaimModal pledge={pledge} claims={claims} live={live} />}
            {isPledger && active && (
              <Button
                size="sm"
                variant="ghost"
                disabled={todayUtc() <= pledge.expires || open.length > 0 || pending === `withdraw:${pledge.id}`}
                title={todayUtc() <= pledge.expires ? `Locked until the pledge expires on ${pledge.expires}.` : open.length ? "Settle the open claims first." : ""}
                onClick={() => write({ kind: "withdraw", pledgeId: pledge.id })}
              >
                Withdraw bond
              </Button>
            )}
          </div>

          {claims.length > 0 && (
            <div className="space-y-2">
              {[...open, ...done].map((c) => (
                <ClaimCard key={c.id} claim={c} pledge={pledge} />
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
