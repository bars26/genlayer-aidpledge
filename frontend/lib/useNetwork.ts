"use client";

import { useEffect, useState } from "react";
import { DEFAULT_NETWORK, NETWORKS, currentNetworkId, type Network, type NetworkId } from "./network";

/**
 * The page's network for rendering: Bradbury on the server and on the first client render (so hydration matches),
 * then the real one. Use this in components; use currentNetwork() in event handlers and data fetching.
 */
export function useNetwork(): Network {
  const [id, setId] = useState<NetworkId>(DEFAULT_NETWORK);
  useEffect(() => setId(currentNetworkId()), []);
  return NETWORKS[id];
}
