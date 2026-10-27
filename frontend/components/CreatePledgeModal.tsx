"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  DONORS,
  MIN_PAYOUT_WEI,
  MIN_TARGET_USD,
  PLANS,
  REPORT_DAYS,
  REPORTING_LAG_DAYS,
  addDays,
  formatGen,
  parseGen,
  shortName,
  todayUtc,
  usd,
  type FundingLookup,
} from "@/lib/contracts/types";
import { usePledgeWrite } from "@/lib/hooks/useAidPledge";
import { useWallet } from "@/lib/genlayer/wallet";
import type { CheckTerms } from "./FundingCheck";
import { FundingBar } from "./FundingBar";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const EXAMPLE_URL = "https://www.gov.uk/government/news/uk-announces-new-humanitarian-funding-for-sudan";

/** Back a donor's public funding pledge with GEN: plain-language terms, checked here with the contract's rules. */
export function CreatePledgeModal({ open, onOpenChange, terms }: { open: boolean; onOpenChange: (o: boolean) => void; terms?: CheckTerms }) {
  const { address, isConnected } = useWallet();
  const { writeAsync, pending } = usePledgeWrite();
  const [f, setF] = useState({ donor: "2917", plan: "1220", target: "150000000", deadline: addDays(todayUtc(), 90), url: "", payout: "2", bond: "", beneficiary: "", expires: "" });

  useEffect(() => {
    if (open && terms) setF((x) => ({ ...x, donor: terms.donor, plan: terms.plan, target: terms.target, deadline: terms.by }));
  }, [open, terms]);

  const target = Number(f.target.replace(/[,_\s]/g, ""));
  const validIds = /^\d{1,8}$/.test(f.donor) && /^\d{1,8}$/.test(f.plan);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(f.deadline);
  const { data: live, isFetching } = useQuery<FundingLookup>({
    queryKey: ["funding", f.donor, f.plan, f.deadline],
    queryFn: async () => (await fetch(`/api/funding?donor=${f.donor}&plan=${f.plan}&by=${f.deadline}`)).json(),
    enabled: open && validIds && validDate,
    staleTime: 10 * 60_000,
  });

  const payout = parseGen(f.payout);
  const bond = f.bond ? parseGen(f.bond) : payout;
  const minExpires = validDate ? addDays(f.deadline, REPORTING_LAG_DAYS + REPORT_DAYS) : "";
  const expires = f.expires || (minExpires ? addDays(minExpires, 30) : "");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const problems = [
    !validIds && "Pick a donor and a response plan (or type their OCHA FTS ids).",
    live && !live.ok && live.error,
    !(Number.isInteger(target) && target >= MIN_TARGET_USD) && `The target must be a whole number of US dollars, at least ${MIN_TARGET_USD.toLocaleString()}.`,
    !validDate && "Pick the deadline for the funding.",
    !/^https:\/\/\S+$/.test(f.url.trim()) && "Paste the https:// link of the donor's public announcement.",
    !(payout && payout >= MIN_PAYOUT_WEI) && "The payout must be at least 1 GEN.",
    !(bond && payout && bond >= payout) && "The bond must cover the payout.",
    !/^0x[0-9a-fA-F]{40}$/.test(f.beneficiary.trim()) && "Enter the beneficiary's wallet address.",
    (!expires || expires < todayUtc() || (minExpires && expires < minExpires)) && `The pledge must run until ${minExpires || "60 days after the deadline"} or later.`,
  ].filter(Boolean) as string[];

  const submit = async () => {
    if (problems.length || !payout || !bond) return;
    try {
      await writeAsync({
        kind: "create",
        bond,
        input: { donorId: f.donor, planId: f.plan, targetUsd: target, deadline: f.deadline, announcementUrl: f.url.trim(), payout, beneficiary: f.beneficiary.trim(), expires },
      });
      onOpenChange(false);
    } catch {
      // shown in the toast and the transactions panel
    }
  };

  const donorKnown = DONORS.some((d) => d.id === f.donor);
  const planKnown = PLANS.some((p) => p.id === f.plan);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="display text-2xl">Back a funding pledge with GEN</DialogTitle>
          <DialogDescription>
            Your GEN stands behind one promise: OCHA&apos;s Financial Tracking Service will record at least the target from this donor to this plan,
            committed or paid, by the deadline. Validators first read the announcement you cite and refuse the pledge unless it is this donor&apos;s
            pledge for this crisis.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Donor</Label>
              <select className="field" value={donorKnown ? f.donor : ""} onChange={(e) => setF({ ...f, donor: e.target.value })}>
                {DONORS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
                <option value="">Other (FTS id)…</option>
              </select>
              {!donorKnown && <Input value={f.donor} onChange={set("donor")} placeholder="FTS organization id" className="mono" />}
            </div>
            <div className="space-y-1">
              <Label>Response plan</Label>
              <select className="field" value={planKnown ? f.plan : ""} onChange={(e) => setF({ ...f, plan: e.target.value })}>
                {PLANS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value="">Other (FTS id)…</option>
              </select>
              {!planKnown && <Input value={f.plan} onChange={set("plan")} placeholder="FTS plan id" className="mono" />}
            </div>
            <div className="space-y-1">
              <Label>Target (USD, committed or paid)</Label>
              <Input value={f.target} onChange={set("target")} inputMode="numeric" className="mono" />
            </div>
            <div className="space-y-1">
              <Label>Deadline</Label>
              <Input type="date" value={f.deadline} onChange={set("deadline")} />
            </div>
          </div>

          <div className="rounded-lg bg-[#F4EFE2] p-3 space-y-2">
            {isFetching && !live ? (
              <p className="text-xs text-muted-foreground">Reading OCHA FTS…</p>
            ) : live?.ok ? (
              <>
                <p className="text-xs">
                  <strong>{shortName(live.donor?.name ?? "")}</strong> to <strong>{live.plan?.name}</strong>, recorded on FTS today and dated by {f.deadline}:
                </p>
                <FundingBar funded={live.funded_usd ?? 0} target={target || 0} after={live.after_usd} />
                {f.deadline < todayUtc() && (
                  <p className="text-[11px] text-[#86580A]">
                    This deadline is past: a claim can be ruled as soon as {addDays(f.deadline, REPORTING_LAG_DAYS)}
                    {(live.funded_usd ?? 0) < target ? `, and FTS shows ${usd(target - (live.funded_usd ?? 0))} short today.` : "."}
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Pick a donor, a plan and a deadline to see what FTS records.</p>
            )}
          </div>

          <div className="space-y-1">
            <Label>The donor&apos;s public announcement</Label>
            <Input value={f.url} onChange={set("url")} placeholder={EXAMPLE_URL} className="mono text-xs" />
            <p className="text-[11px] text-muted-foreground">
              A press release or statement where this donor announces funding for this crisis. Validators read it during the transaction.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Payout for a total shortfall (GEN)</Label>
              <Input value={f.payout} onChange={set("payout")} inputMode="decimal" />
              <p className="text-[11px] text-muted-foreground">A partial shortfall pays pro rata: 10% short pays 10%.</p>
            </div>
            <div className="space-y-1">
              <Label>Bond (GEN)</Label>
              <Input value={f.bond} onChange={set("bond")} inputMode="decimal" placeholder={payout ? formatGen(payout) : ""} />
              <p className="text-[11px] text-muted-foreground">At least the payout, so any shortfall is paid in full.</p>
            </div>
            <div className="space-y-1">
              <Label>Pledge open until</Label>
              <Input type="date" value={expires} onChange={set("expires")} />
              {minExpires && (
                <p className="text-[11px] text-muted-foreground">
                  Earliest {minExpires}: {REPORTING_LAG_DAYS} days for FTS reports, then {REPORT_DAYS} days to claim.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Beneficiary wallet</Label>
              <Input value={f.beneficiary} onChange={set("beneficiary")} placeholder="0x… e.g. a pooled fund" className="mono" />
              {address && (
                <button type="button" className="text-[11px] text-[#14213D] underline" onClick={() => setF({ ...f, beneficiary: address })}>
                  use my wallet
                </button>
              )}
            </div>
          </div>
        </div>
        {problems.length > 0 && (
          <ul className="text-xs text-[#9A3220] list-disc pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <Button onClick={submit} className="w-full" disabled={!isConnected || problems.length > 0 || pending === "create"}>
          {pending === "create" && <Loader2 className="w-4 h-4 animate-spin" />}
          {isConnected ? `Bond ${bond ? formatGen(bond) : "?"} GEN and pledge` : "Connect a wallet to pledge"}
        </Button>
        <p className="text-xs text-muted-foreground">Validators read FTS and the announcement during the transaction; it usually takes 1 to 3 minutes.</p>
      </DialogContent>
    </Dialog>
  );
}
