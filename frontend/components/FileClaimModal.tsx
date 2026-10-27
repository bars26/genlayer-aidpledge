"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { claimsOpen, formatGen, shortName, stakeFor, todayUtc, usd, wei, type Claim, type FundingLookup, type Pledge } from "@/lib/contracts/types";
import { usePledgeWrite } from "@/lib/hooks/useAidPledge";
import { useWallet } from "@/lib/genlayer/wallet";
import { FundingBar } from "./FundingBar";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

/** Report that a pledge fell short: see what FTS records today, then stake and file. */
export function FileClaimModal({ pledge, claims, live }: { pledge: Pledge; claims: Claim[]; live?: FundingLookup }) {
  const { isConnected } = useWallet();
  const { writeAsync, pending } = usePledgeWrite();
  const [open, setOpen] = useState(false);
  const stake = stakeFor(pledge);
  const target = Number(pledge.target_usd);
  const funded = live?.funded_usd ?? 0;
  const gap = Math.max(target - funded, 0);
  const share = target ? gap / target : 0;
  const payNow = (wei(pledge.payout) * BigInt(Math.round(share * 10000))) / 10000n;
  // The same rules the contract applies; a claim it would refund is blocked here with the reason.
  const openClaim = claims.find((c) => c.state === "pending");
  const opens = claimsOpen(pledge);
  const blocked =
    todayUtc() < opens
      ? `Claims open on ${opens}: FTS needs 30 days to record funding dated up to ${pledge.deadline}.`
      : todayUtc() > pledge.expires
        ? `This pledge expired on ${pledge.expires}.`
        : openClaim
          ? `${openClaim.id} is already open for this pledge; follow it on the card.`
          : "";

  const submit = async () => {
    try {
      await writeAsync({ kind: "file", pledgeId: pledge.id });
      setOpen(false);
    } catch {
      // shown in the toast and the transactions panel
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Report a shortfall
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="display text-2xl">Did the funding fall short?</DialogTitle>
          <DialogDescription>
            You stake <strong>{formatGen(stake)} GEN</strong>. Validators read OCHA FTS themselves. If the target was missed, the bond pays the beneficiary
            in proportion to the gap and you get your stake back plus 10% of what is paid. If it was met, your stake goes to the bond. If FTS cannot be
            read, it comes back.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg bg-[#F4EFE2] p-3 space-y-2">
          <p className="text-xs">
            {shortName(pledge.donor_name)}, dated by {pledge.deadline}, as FTS records it today:
          </p>
          {live?.ok ? <FundingBar funded={funded} target={target} after={live.after_usd} /> : <div className="h-14 rounded-lg bg-[#E9E3D3]/60 animate-pulse" />}
          {live?.ok &&
            (gap > 0 ? (
              <p className="text-xs">
                If validators read the same, the shortfall is {usd(gap)} ({(share * 100).toFixed(2)}%): about <strong>{formatGen(payNow, 3)} GEN</strong> would
                be paid, {formatGen((payNow * 9n) / 10n, 3)} to the beneficiary and {formatGen(payNow / 10n, 3)} to you on top of your stake.
              </p>
            ) : (
              <p className="text-xs text-[#86580A]">The target looks met: the ruling would likely keep the promise and your stake would go to the bond.</p>
            ))}
        </div>
        {blocked && <p className="text-xs text-[#86580A]">{blocked}</p>}
        <Button className="w-full" onClick={submit} disabled={!isConnected || !!blocked || pending === `file:${pledge.id}`}>
          {pending === `file:${pledge.id}` && <Loader2 className="w-4 h-4 animate-spin" />}
          {isConnected ? `Stake ${formatGen(stake)} GEN and report` : "Connect a wallet to report"}
        </Button>
        <p className="text-xs text-muted-foreground">Validators read OCHA FTS during the transaction; it usually takes 1 to 3 minutes.</p>
      </DialogContent>
    </Dialog>
  );
}
