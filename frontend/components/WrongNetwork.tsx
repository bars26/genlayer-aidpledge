"use client";

import { AlertTriangle } from "lucide-react";
import { switchToGenLayerNetwork } from "@/lib/genlayer/client";
import { useWallet } from "@/lib/genlayer/wallet";
import { useNetwork } from "@/lib/useNetwork";
import { error } from "@/lib/utils/toast";
import { Button } from "./ui/button";

/** Shown when the connected wallet is on another chain than the page's network; one click asks MetaMask to switch. */
export function WrongNetwork() {
  const { isConnected, isOnCorrectNetwork, isLoading } = useWallet();
  const net = useNetwork();
  if (!isConnected || isLoading || isOnCorrectNetwork) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className="border-[#B7791F] text-[#7A520F]"
      onClick={() => switchToGenLayerNetwork().catch((e) => error("Could not switch network", { description: e?.message }))}
      title={`Your wallet is on another chain. Switch MetaMask to ${net.chainName} (chain id ${net.chainId}).`}
    >
      <AlertTriangle className="h-4 w-4" />
      <span className="hidden sm:inline">Switch to {net.short}</span>
    </Button>
  );
}
