/**
 * AidPledge's contract source runs on two GenLayer networks: GenLayer Studio (the default, where photo conditions are
 * judged) and Bradbury testnet. Addresses can be overridden with NEXT_PUBLIC_STUDIO_CONTRACT / NEXT_PUBLIC_BRADBURY_CONTRACT.
 * The page picks a network from `?network=` (then the last choice, then the default).
 */

export type NetworkId = "bradbury" | "studio";

export type Network = {
  id: NetworkId;
  label: string;
  short: string;
  chainId: number;
  chainName: string;
  /** RPC MetaMask sends transactions to. */
  rpc: string;
  /** RPC that answers contract reads (gen_call). On Bradbury this is a GenLayer node, not the chain RPC. */
  readRpc: string;
  explorer: string;
  contract: string;
  faucet: string;
  /** Studio rate-limits contract calls per IP; Bradbury does not. */
  rateLimited: boolean;
};

export const NETWORKS: Record<NetworkId, Network> = {
  bradbury: {
    id: "bradbury",
    label: "Bradbury testnet",
    short: "Bradbury",
    chainId: 4221,
    chainName: "GenLayer Bradbury Testnet",
    rpc: "https://rpc.testnet-chain.genlayer.com",
    readRpc: "https://rpc-bradbury.genlayer.com",
    explorer: "https://explorer-bradbury.genlayer.com",
    contract: process.env.NEXT_PUBLIC_BRADBURY_CONTRACT || "0xa32C73fd75FC2e5b52484fcE2B8758D046CbA62F",
    faucet: "https://testnet-faucet.genlayer.foundation",
    rateLimited: false,
  },
  studio: {
    id: "studio",
    label: "GenLayer Studio",
    short: "Studio",
    chainId: 61999,
    chainName: "GenLayer Studio",
    rpc: "https://studio.genlayer.com/api",
    readRpc: "https://studio.genlayer.com/api",
    explorer: "https://explorer-studio.genlayer.com",
    contract: process.env.NEXT_PUBLIC_STUDIO_CONTRACT || "0x38d91447B1e435D183B062344CF4c5539B96f965",
    faucet: "",
    rateLimited: true,
  },
};

const KEY = "aidpledge_network";
export const DEFAULT_NETWORK: NetworkId = "studio"; // photo conditions need Studio validators; Bradbury is one switch away
export const hasBradbury = () => /^0x[0-9a-fA-F]{40}$/.test(NETWORKS.bradbury.contract);
const isId = (v: unknown): v is NetworkId => v === "bradbury" || v === "studio";

export function networkFrom(param: string | null | undefined): NetworkId {
  return isId(param) && (param === "studio" || hasBradbury()) ? param : DEFAULT_NETWORK;
}

/** The page's network (browser only; the server renders Bradbury and the client corrects before any read). */
export function currentNetworkId(): NetworkId {
  if (typeof window === "undefined") return DEFAULT_NETWORK;
  if (!hasBradbury()) return "studio";
  const fromUrl = new URLSearchParams(window.location.search).get("network");
  if (isId(fromUrl)) {
    try {
      localStorage.setItem(KEY, fromUrl);
    } catch {}
    return fromUrl;
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (isId(saved)) return saved;
  } catch {}
  return DEFAULT_NETWORK;
}

export const currentNetwork = (): Network => NETWORKS[currentNetworkId()];

export function switchNetwork(id: NetworkId) {
  try {
    localStorage.setItem(KEY, id);
  } catch {}
  const url = new URL(window.location.href);
  url.searchParams.set("network", id);
  url.hash = "";
  window.location.assign(url.toString());
}

export const txUrl = (n: Network, hash: string) => `${n.explorer}/tx/${hash}`;
export const addressUrl = (n: Network, address: string) => `${n.explorer}/address/${address}`;

