"use client";

import { NETWORKS, hasBradbury, switchNetwork, type NetworkId } from "@/lib/network";
import { useNetwork } from "@/lib/useNetwork";

/** Bradbury testnet or GenLayer Studio: the same contract on both; switching reloads the page on the other network. */
export function NetworkSwitch() {
  const id = useNetwork().id;
  if (!hasBradbury()) return null;
  return (
    <div className="flex rounded-lg border border-border bg-white/70 p-0.5 text-xs" role="group" aria-label="GenLayer network">
      {(Object.keys(NETWORKS) as NetworkId[]).map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => n !== id && switchNetwork(n)}
          aria-pressed={n === id}
          title={n === "bradbury" ? "Bradbury testnet: five independent validators (GEN from the testnet faucet)" : "GenLayer Studio: free test GEN"}
          className={`rounded-md px-2 py-1 font-semibold transition-colors ${n === id ? "bg-[#0E1E33] text-white" : "text-muted-foreground hover:text-foreground"}`}
        >
          {NETWORKS[n].short}
        </button>
      ))}
    </div>
  );
}
