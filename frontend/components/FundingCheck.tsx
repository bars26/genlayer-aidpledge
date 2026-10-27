"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, Search } from "lucide-react";
import { DONORS, PLANS, shortName, usd, usdFull, type FundingLookup } from "@/lib/contracts/types";
import { FundingBar } from "./FundingBar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export interface CheckTerms {
  donor: string;
  plan: string;
  by: string;
  target: string;
}

const OTHER = "other";

/** Wallet-free: how much has a donor committed or paid to a response plan by a date, per OCHA FTS? */
export function FundingCheck({ onPledge }: { onPledge: (t: CheckTerms) => void }) {
  const [t, setT] = useState<CheckTerms>({ donor: "2917", plan: "1220", by: "2026-03-31", target: "150000000" });
  const [custom, setCustom] = useState({ donor: false, plan: false });
  const [asked, setAsked] = useState<CheckTerms>(t);
  const { data, isFetching, error } = useQuery<FundingLookup, Error>({
    queryKey: ["funding", asked.donor, asked.plan, asked.by],
    queryFn: async () => {
      const res = await fetch(`/api/funding?donor=${asked.donor}&plan=${asked.plan}&by=${asked.by}`);
      return res.json();
    },
    enabled: /^\d+$/.test(asked.donor) && /^\d+$/.test(asked.plan) && /^\d{4}-\d{2}-\d{2}$/.test(asked.by),
    staleTime: 10 * 60_000,
  });
  const target = Number(asked.target.replace(/[,_\s]/g, "")) || 0;
  const set = (k: keyof CheckTerms) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setT({ ...t, [k]: e.target.value });
  const pick = (k: "donor" | "plan") => (e: React.ChangeEvent<HTMLSelectElement>) => {
    const other = e.target.value === OTHER;
    setCustom({ ...custom, [k]: other });
    setT({ ...t, [k]: other ? "" : e.target.value });
  };

  return (
    <div className="brand-card p-5 md:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Search className="w-4 h-4 text-[#B07A12]" />
        <h2 className="display text-xl">Check a donor&apos;s funding</h2>
        <span className="ml-auto text-[11px] text-muted-foreground">no wallet needed</span>
      </div>
      <form
        className="grid grid-cols-2 gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked(t);
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="donor">Donor</Label>
          <select id="donor" className="field" value={custom.donor ? OTHER : t.donor} onChange={pick("donor")}>
            {DONORS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
            <option value={OTHER}>Other (FTS id)…</option>
          </select>
          {custom.donor && <Input value={t.donor} onChange={set("donor")} placeholder="FTS organization id" className="mono" inputMode="numeric" />}
        </div>
        <div className="space-y-1">
          <Label htmlFor="plan">Response plan</Label>
          <select id="plan" className="field" value={custom.plan ? OTHER : t.plan} onChange={pick("plan")}>
            {PLANS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={OTHER}>Other (FTS id)…</option>
          </select>
          {custom.plan && <Input value={t.plan} onChange={set("plan")} placeholder="FTS plan id" className="mono" inputMode="numeric" />}
        </div>
        <div className="space-y-1">
          <Label htmlFor="by">Funded by</Label>
          <Input id="by" type="date" value={t.by} onChange={set("by")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="target">Target (USD)</Label>
          <Input id="target" value={t.target} onChange={set("target")} inputMode="numeric" className="mono" />
        </div>
        <Button type="submit" variant="outline" className="col-span-2" disabled={isFetching}>
          {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          Read OCHA FTS
        </Button>
      </form>

      {error && <p className="text-sm text-[#9A3220]">Could not reach the lookup: {error.message}</p>}
      {data && !data.ok && <p className="rounded-lg bg-[#F9E1DA] px-3 py-2 text-sm text-[#9A3220]">{data.error}</p>}
      {data?.ok && (
        <div className="space-y-3 animate-fade-in">
          <p className="text-sm">
            <strong>{shortName(data.donor?.name ?? "")}</strong> to <strong>{data.plan?.name}</strong>{" "}
            <span className="text-muted-foreground">
              ({data.plan?.code}, {data.plan?.start} to {data.plan?.end})
            </span>
          </p>
          <FundingBar funded={data.funded_usd ?? 0} target={target} after={data.after_usd} />
          <p className="text-xs text-muted-foreground">
            {data.counted} of {data.flows?.length} flows count: committed or paid, dated on or before {data.by}.
            {data.pledged_only_usd ? ` ${usd(data.pledged_only_usd)} is only pledged, which FTS does not count as funding.` : ""}
          </p>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">The flows FTS lists</summary>
            <table className="mt-2 w-full">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="font-normal">Flow</th>
                  <th className="font-normal">Date</th>
                  <th className="font-normal">Status</th>
                  <th className="font-normal text-right">USD</th>
                </tr>
              </thead>
              <tbody className="mono">
                {data.flows?.map((f) => (
                  <tr key={f.id} className={f.date <= (data.by ?? "") && f.status !== "pledge" ? "" : "text-muted-foreground line-through"}>
                    <td>
                      <a href={`https://fts.unocha.org/flows/${f.id}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
                        {f.id}
                      </a>
                    </td>
                    <td>{f.date}</td>
                    <td>{f.status}</td>
                    <td className="text-right">{usdFull(f.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => onPledge(asked)}>
              Back this target with GEN
            </Button>
            <a href={data.record} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              Open the plan on FTS <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
