import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { createClient as createBradburyClient } from "genlayer-js-bradbury";
import { testnetBradbury } from "genlayer-js-bradbury/chains";
import { NETWORKS, networkFrom, type NetworkId } from "@/lib/network";

/**
 * Server-side snapshot of every pledge and claim, cached at the CDN.
 *
 * GenLayer Studio rate-limits per IP and counts contract reads (`gen_call`) in the same
 * 30-per-minute bucket as `eth_sendRawTransaction`. Reading the registry from the visitor's
 * browser would spend the budget the visitor needs for their own transactions, so it is read
 * here, with one `get_pledges` and one `get_claims` call per 200 items,
 * and served from the CDN. On Bradbury, reads go to a GenLayer node RPC (the chain RPC does not answer gen_call).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Snapshot = { pledges: unknown[]; claims: unknown[]; fetchedAt: string };
const memo: Partial<Record<NetworkId, { at: number; data: Snapshot }>> = {};
const MEMO_MS = 10_000;
const PAGE = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function read<T>(client: any, functionName: string, args: unknown[]): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await client.readContract({ address: client.aidpledge, functionName, args })) as T;
    } catch (err) {
      last = err;
      await sleep(1500 * 2 ** attempt);
    }
  }
  throw last;
}

function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v)));
}

async function readAll(client: any, functionName: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await read<unknown[]>(client, functionName, [offset, PAGE]);
    out.push(...page.map(toJson));
    if (page.length < PAGE) return out;
  }
}

async function load(id: NetworkId): Promise<Snapshot> {
  const net = NETWORKS[id];
  const client: any =
    id === "bradbury"
      ? createBradburyClient({ chain: testnetBradbury, endpoint: net.readRpc } as any)
      : createClient({ chain: studionet, endpoint: net.readRpc } as any);
  client.aidpledge = net.contract;
  const [pledges, claims] = await Promise.all([readAll(client, "get_pledges"), readAll(client, "get_claims")]);
  return { pledges, claims, fetchedAt: new Date().toISOString() };
}

export async function GET(request: Request) {
  const id = networkFrom(new URL(request.url).searchParams.get("network"));
  const cached = memo[id];
  try {
    if (!cached || Date.now() - cached.at > MEMO_MS) {
      const data = await load(id);
      if (!cached || data.pledges.length + data.claims.length >= cached.data.pledges.length + cached.data.claims.length) memo[id] = { at: Date.now(), data };
    }
    return Response.json(memo[id]!.data, {
      // Short on purpose: a long stale-while-revalidate would show the first visitor after a
      // quiet period a registry from hours ago, with claims that were settled meanwhile.
      headers: { "Cache-Control": id === "bradbury" ? "public, s-maxage=30, stale-while-revalidate=600" : "public, s-maxage=15, stale-while-revalidate=45" },
    });
  } catch (err) {
    if (memo[id]) return Response.json(memo[id]!.data, { headers: { "Cache-Control": "public, s-maxage=10" } });
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
