"use client";

import { Loader2 } from "lucide-react";
import {
  CODE_LABEL,
  OUTCOME_TEXT,
  VERDICT_STYLE,
  evidenceOf,
  factsOf,
  formatGen,
  sameAddress,
  timelineOf,
  windowLeftSeconds,
  type Claim,
  type EvidencePacket,
  type Pledge,
  usd,
  usdFull,
} from "@/lib/contracts/types";
import { formatAddress, useWallet } from "@/lib/genlayer/wallet";
import { useNow } from "@/lib/hooks/useNow";
import { usePledgeWrite } from "@/lib/hooks/useAidPledge";
import { Button } from "./ui/button";

/** One claim: the ruling, its reason, the FTS flows validators read, its timeline and what you can do now. */
export function ClaimCard({ claim, pledge }: { claim: Claim; pledge: Pledge }) {
  const { address } = useWallet();
  const { write, pending } = usePledgeWrite();
  const now = useNow(1000);
  const f = factsOf(claim);
  const steps = timelineOf(claim);
  const packets = evidenceOf(claim);
  const left = windowLeftSeconds(claim, now);
  const open = claim.state === "pending";
  const breach = claim.verdict === "BREACHED";
  const isPledger = sameAddress(pledge.pledger, address);
  const isReporter = sameAddress(claim.claimant, address);
  const canContest = open && left > 0 && (breach ? isPledger && !claim.pledger_contested : isReporter && !claim.claimant_contested);
  const canSettle = open && (left === 0 || (breach ? isPledger : isReporter));
  const busy = pending === `contest:${claim.id}` || pending === `settle:${claim.id}`;
  const v = VERDICT_STYLE[claim.verdict];

  return (
    <div className="rounded-xl border border-border bg-[#FFFDF8] p-4 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${v?.cls}`} title={v?.help}>
          {v?.label}
        </span>
        <span className="font-medium">{f.funded_usd !== undefined && claim.code !== "unreachable" ? `${usd(f.funded_usd)} of ${usd(f.target_usd)}` : "no reading"}</span>
        <span className="text-xs text-muted-foreground">{CODE_LABEL[claim.code] ?? claim.code}</span>
        <span className="ml-auto text-xs mono text-muted-foreground">{claim.id}</span>
      </div>

      <p className="leading-relaxed">
        <span className="font-semibold">Why: </span>
        {claim.why}
      </p>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">What the validators read</summary>
        <dl className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
          <Fact k="Deadline" v={f.deadline || "—"} />
          <Fact k="Target" v={f.target_usd !== undefined ? usdFull(f.target_usd) : "—"} />
          <Fact k="Counted (by deadline)" v={f.funded_usd !== undefined ? `${usdFull(f.funded_usd)} in ${f.flows_counted} flows` : "—"} />
          <Fact k="Shortfall" v={f.shortfall_usd ? `${usdFull(f.shortfall_usd)} (${((f.shortfall_bp ?? 0) / 100).toFixed(2)}%)` : "—"} />
          <Fact k="Dated after the deadline" v={f.after_deadline_usd ? usdFull(f.after_deadline_usd) : "—"} />
          <Fact k="Only pledged" v={f.pledged_only_usd ? usdFull(f.pledged_only_usd) : "—"} />
        </dl>
        {packets.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="font-medium text-foreground">Evidence packets (one per reading, stored on-chain)</p>
            {packets.map((e, i) => (
              <Packet key={i} n={i + 1} e={e} />
            ))}
          </div>
        )}
      </details>

      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[#F2B33D]" />
            <span className="mono">{s.at.slice(5, 16).replace("T", " ")}</span>
            <span className="text-foreground">
              {s.event === "filed" && `reported by ${formatAddress(claim.claimant)} → ${s.verdict}`}
              {s.event === "contested" && `${s.by} asked for a fresh reading: ${s.before} → ${s.verdict}`}
              {s.event === "settled" &&
                (s.outcome === "paid"
                  ? `${((s.share_bp ?? 0) / 100).toFixed(2)}% of the payout: ${formatGen(s.beneficiary, 3)} GEN to the beneficiary, ${formatGen(s.reporter, 3)} GEN + stake to the reporter`
                  : OUTCOME_TEXT[s.outcome ?? ""] ?? "settled")}
            </span>
          </li>
        ))}
      </ol>

      {open && (
        <p className="text-xs text-[#8A5A08]">
          {left > 0
            ? `Response window: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left. ${breach ? "Only the pledger can contest or concede now." : "Only the reporter can contest or accept now."} After it, anyone can settle.`
            : "The response window is over: anyone can settle."}
        </p>
      )}

      {(canContest || canSettle) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {canContest && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => write({ kind: "contest", claimId: claim.id })}>
              {pending === `contest:${claim.id}` && <Loader2 className="w-3 h-3 animate-spin" />}
              Ask for a fresh reading
            </Button>
          )}
          {canSettle && (
            <Button size="sm" disabled={busy} onClick={() => write({ kind: "settle", claimId: claim.id })}>
              {pending === `settle:${claim.id}` && <Loader2 className="w-3 h-3 animate-spin" />}
              {left > 0 ? (breach ? "Concede and pay now" : "Accept the ruling now") : "Settle"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** What one reading saw on OCHA FTS, with the hashes that commit to it. */
function Packet({ n, e }: { n: number; e: EvidencePacket }) {
  const hash = (h?: string) => <span className="mono break-all">{h ? `${h.slice(0, 16)}…` : "—"}</span>;
  return (
    <div className="rounded-lg border border-border bg-white/70 p-2 space-y-1">
      <p className="text-muted-foreground">
        #{n} read {e.read_at?.replace("T", " ")} UTC · packet {hash(e.packet_sha256)} · flows {hash(e.flows_sha256)}
      </p>
      <p>
        Query:{" "}
        <a href={e.source} target="_blank" rel="noopener noreferrer" className="text-[#14213D] break-all hover:underline">
          {e.source}
        </a>
      </p>
      {e.flows?.length ? (
        <>
          <p className="text-muted-foreground">
            {e.flows_total} incoming flows{e.fts_total_incoming ? `, FTS total ${usdFull(e.fts_total_incoming)}` : ""}
            {(e.flows_total ?? 0) > e.flows.length ? ` (first ${e.flows.length} stored; all were counted)` : ""}
          </p>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
            {e.flows.map((fl) => (
              <li key={fl.id} className="mono">
                {fl.date} · {fl.status} · {usdFull(fl.usd)} <span className="text-muted-foreground">#{fl.id}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-muted-foreground">No flows in this reading.</p>
      )}
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="mono break-words">{v}</dd>
    </div>
  );
}
