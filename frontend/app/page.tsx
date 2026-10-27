"use client";

import { useState } from "react";
import { HandCoins, Landmark, Loader2, RefreshCw, Scale, Send } from "lucide-react";
import { CreatePledgeModal } from "@/components/CreatePledgeModal";
import { FundingCheck, type CheckTerms } from "@/components/FundingCheck";
import { Navbar } from "@/components/Navbar";
import { PledgeCard } from "@/components/PledgeCard";
import { TransactionPanel } from "@/components/TransactionPanel";
import { Button } from "@/components/ui/button";
import { formatGen, wei } from "@/lib/contracts/types";
import { useRegistry } from "@/lib/hooks/useAidPledge";

const STEPS = [
  { icon: Landmark, title: "A pledge is announced", body: "A government promises aid for a crisis. Anyone can bond GEN behind it: this much money, to this plan, by this date." },
  { icon: HandCoins, title: "Validators read the promise", body: "They read the donor's own announcement and refuse the bond unless it really is this donor's pledge for this crisis." },
  { icon: Scale, title: "FTS is the scoreboard", body: "After the deadline, anyone can report a shortfall. Validators add up what OCHA's Financial Tracking Service records as committed or paid." },
  { icon: Send, title: "The gap is paid", body: "A shortfall pays the beneficiary in proportion to the gap: 6% short pays 6%. The reporter earns 10% of it." },
];

export default function HomePage() {
  const { pledges, claims, isLoading, isError, error, isFetching, refetch, fetchedAt } = useRegistry();
  const [modal, setModal] = useState<{ open: boolean; terms?: CheckTerms }>({ open: false });
  const ordered = [...pledges].sort((a, b) => Number(b.id.split("_")[1]) - Number(a.id.split("_")[1]));
  const bonded = pledges.filter((p) => p.state === "active").reduce((t, p) => t + wei(p.bond), 0n);
  const crises = new Set(pledges.map((p) => p.plan_id)).size;
  const paid = pledges.reduce((t, p) => t + wei(p.total_paid), 0n);

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar onPledge={() => setModal({ open: true })} />
      <main className="flex-grow pt-24 pb-12 px-4 md:px-6">
        <div className="max-w-6xl mx-auto space-y-10">
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            <div className="lg:col-span-5 space-y-4 lg:pt-6">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#B07A12]">Humanitarian pledges, with money on delivery</p>
              <h1 className="display text-5xl md:text-6xl leading-[1.02]">Did the aid arrive?</h1>
              <p className="text-lg text-muted-foreground">
                Donors announce millions for a crisis at a conference. Months later, nobody checks. On AidPledge, GEN is bonded behind an announced
                pledge, and GenLayer validators check the UN&apos;s own funding records when the deadline passes.
              </p>
              <dl className="flex gap-8 pt-1">
                <div>
                  <dt className="text-xs text-muted-foreground">GEN bonded</dt>
                  <dd className="display text-3xl">{formatGen(bonded, 1)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">crises watched</dt>
                  <dd className="display text-3xl">{crises}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">GEN paid for gaps</dt>
                  <dd className="display text-3xl">{formatGen(paid, 2)}</dd>
                </div>
              </dl>
            </div>
            <div className="lg:col-span-7">
              <FundingCheck onPledge={(terms) => setModal({ open: true, terms })} />
            </div>
          </section>

          <section>
            <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {STEPS.map(({ icon: Icon, title, body }, i) => (
                <li key={title} className="rounded-2xl border border-border bg-white/60 p-4">
                  <div className="flex items-center gap-2">
                    <span className="display flex h-7 w-7 items-center justify-center rounded-full bg-[#14213D] text-sm text-[#F2B33D]">{i + 1}</span>
                    <Icon className="w-4 h-4 text-[#B07A12]" />
                    <span className="font-semibold">{title}</span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{body}</p>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">
              Checking needs no wallet. To pledge or report, connect MetaMask and press Test GEN for free GenLayer Studio tokens. The pledges below are
              demo pledges made by test wallets, not by any government; their targets are demo terms, not findings about any donor.
            </p>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            <div className="lg:col-span-8 space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="display text-3xl">Bonded pledges</h2>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {fetchedAt && <span>updated {new Date(fetchedAt).toLocaleTimeString()}</span>}
                  <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching} aria-label="Refresh">
                    {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
              {isLoading && <p className="text-sm text-muted-foreground">Reading the pledges from GenLayer Studio…</p>}
              {isError && <p className="rounded-xl border border-[#EFC0B3] bg-[#F9E1DA] p-3 text-sm">Could not read the pledges: {error?.message}. Try Refresh in a minute.</p>}
              {!isLoading && !isError && ordered.length === 0 && <p className="text-sm text-muted-foreground">No pledge is bonded yet. Check a donor above and be the first.</p>}
              {ordered.map((p) => (
                <div id={p.id} key={p.id}>
                  <PledgeCard pledge={p} claims={claims.filter((c) => c.pledge_id === p.id)} />
                </div>
              ))}
            </div>
            <aside className="lg:col-span-4 space-y-6">
              <div className="brand-card p-5 space-y-3 text-sm">
                <h3 className="display text-xl">How a ruling is made</h3>
                <p>
                  <strong>Read in code.</strong> Validators query OCHA FTS for every incoming flow from the donor to the plan. Flows marked committed or paid
                  and dated on or before the deadline count. Bare pledges and later flows never do.
                </p>
                <p>
                  <strong>The promise is checked first.</strong> At pledging, validators read the donor&apos;s announcement and answer one question: is
                  this the donor&apos;s funding pledge for this crisis? Anything but a yes refunds the bond.
                </p>
                <p>
                  <strong>Fair to slow reporting.</strong> Donors report to FTS late, so claims open 30 days after the deadline, and the side a ruling
                  goes against can ask once for a fresh reading within 10 minutes.
                </p>
                <p>
                  <strong>Always paid in full.</strong> The bond covers the whole payout and pays once. Every reading keeps the flows read, with sha256
                  hashes. If FTS is down, nothing is decided and the stake comes back.
                </p>
              </div>
              <TransactionPanel />
            </aside>
          </section>
        </div>
      </main>
      <footer className="border-t border-border py-4 px-4 text-center text-sm text-muted-foreground">
        Data:{" "}
        <a href="https://fts.unocha.org" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
          OCHA Financial Tracking Service
        </a>
        {" · "}
        <a href="https://genlayer.com" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
          Built on GenLayer
        </a>
        {" · "}
        <a href="https://github.com/bars26/genlayer-aidpledge" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
          Source
        </a>
        {" · "}Rulings are about FTS records only, not about any donor&apos;s intentions.
      </footer>
      <CreatePledgeModal open={modal.open} terms={modal.terms} onOpenChange={(open) => setModal((m) => ({ ...m, open }))} />
    </div>
  );
}
