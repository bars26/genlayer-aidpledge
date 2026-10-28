/**
 * Wallet-free funding check against OCHA's Financial Tracking Service, read the same way the
 * contract reads it:
 *
 *   /api/funding?donor=2917&plan=1220&by=2026-03-31
 *
 * Counts incoming flows from the donor to the plan with status commitment or paid, dated on or
 * before `by`. Bare pledges and flows dated later are reported separately and never counted.
 * The rulings themselves are made on-chain by the validators.
 */

import { FUNDED, type Flow, type FundingLookup } from "@/lib/contracts/types";

export const dynamic = "force-dynamic";

const FTS = "https://api.hpc.tools/v1/public";
const HEADERS = { accept: "application/json", "user-agent": "AidPledge/1.0 (GenLayer)" };

async function fts(url: string): Promise<{ state: "ok" | "none" | "error"; data: any; meta: any }> {
  try {
    const res = await fetch(url, { headers: HEADERS, next: { revalidate: 900 } });
    if (res.status === 404) return { state: "none", data: null, meta: {} };
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || (body.status && body.status !== "ok")) return { state: "error", data: null, meta: {} };
    return { state: "ok", data: body.data, meta: body.meta ?? {} };
  } catch {
    return { state: "error", data: null, meta: {} };
  }
}

const PAGE = 100;
const MAX_PAGES = 50;

/** Every page of the donor-to-plan flow list, checked complete the way the contract checks it. */
async function allFlows(query: string): Promise<{ state: "ok" | "error" | "incomplete"; flows: any[]; pages: number }> {
  const byId = new Map<string, any>();
  let reported: number | null = null;
  let incomingReported: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fts(`${query}&page=${page}`);
    if (r.state !== "ok" || !Array.isArray(r.data?.flows)) return { state: "error", flows: [], pages: page };
    const count = r.meta?.count;
    if (typeof count !== "number" || (reported !== null && count !== reported)) return { state: "incomplete", flows: [], pages: page };
    if (reported === null) {
      reported = count;
      incomingReported = typeof r.data?.incoming?.flowCount === "number" ? r.data.incoming.flowCount : null;
    }
    for (const f of r.data.flows) byId.set(String(f.id ?? ""), f);
    if (!r.meta?.nextLink || r.data.flows.length === 0) {
      const flows = [...byId.values()];
      const nIncoming = flows.filter((f) => f.boundary === "incoming").length;
      const complete = !byId.has("") && byId.size === reported && (incomingReported === null || nIncoming === incomingReported);
      return { state: complete ? "ok" : "incomplete", flows, pages: page };
    }
  }
  return { state: "incomplete", flows: [], pages: MAX_PAGES };
}

const json = (body: FundingLookup, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": status === 200 ? "public, s-maxage=600, stale-while-revalidate=1800" : "no-store" } });

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const donorId = (q.get("donor") || "").trim();
  const planId = (q.get("plan") || "").trim();
  const by = (q.get("by") || "").trim();
  if (!/^\d{1,8}$/.test(donorId) || !/^\d{1,8}$/.test(planId)) return json({ ok: false, error: "Donor and plan must be OCHA FTS ids, like 2917 and 1220." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(by)) return json({ ok: false, error: "The date must be YYYY-MM-DD." }, 400);

  const flowsUrl = `${FTS}/fts/flow?planId=${planId}&filterBy=sourceOrganizationId:${donorId}&limit=${PAGE}`;
  const [donorRes, planRes, flowRes] = await Promise.all([
    fts(`${FTS}/fts/flow?organizationId=${donorId}&limit=1`),
    fts(`${FTS}/plan/id/${planId}`),
    allFlows(flowsUrl),
  ]);
  if (donorRes.state === "error" || planRes.state === "error" || flowRes.state === "error")
    return json({ ok: false, error: "OCHA FTS could not be read right now. Try again in a minute." }, 502);
  if (flowRes.state === "incomplete")
    return json({ ok: false, error: "OCHA FTS did not return the complete list of flows; nothing is counted from a partial list. Try again later." }, 502);

  let donor: FundingLookup["donor"] = null;
  for (const f of donorRes.data?.flows ?? [])
    for (const o of [...(f.sourceObjects ?? []), ...(f.destinationObjects ?? [])])
      if (!donor && o.type === "Organization" && String(o.id) === donorId) donor = { id: donorId, name: String(o.name || "") };
  if (!donor) return json({ ok: false, error: `OCHA FTS has no organization ${donorId}.` }, 404);

  const v = planRes.data?.planVersion;
  if (planRes.state === "none" || !v) return json({ ok: false, error: `OCHA FTS has no plan ${planId}.` }, 404);
  const plan = {
    id: planId,
    name: String(v.name || ""),
    code: String(v.code || ""),
    start: String(v.startDate || "").slice(0, 10),
    end: String(v.endDate || "").slice(0, 10),
    locations: (planRes.data.locations ?? []).map((l: any) => String(l.name || "")).slice(0, 8),
  };

  const flows: Flow[] = flowRes.flows
    .filter((f: any) => f.boundary === "incoming")
    .map((f: any) => ({
      id: String(f.id ?? ""),
      status: String(f.status ?? ""),
      date: String(f.date ?? "").slice(0, 10),
      usd: Math.trunc(Number(f.amountUSD) || 0),
      reported: String(f.firstReportedDate ?? "").slice(0, 10),
    }))
    .sort((a: Flow, b: Flow) => (a.date + a.id).localeCompare(b.date + b.id));

  let funded = 0, after = 0, pledgedOnly = 0, counted = 0;
  for (const f of flows) {
    if (FUNDED.includes(f.status) && f.date && f.date <= by) {
      funded += f.usd;
      counted++;
    } else if (FUNDED.includes(f.status)) after += f.usd;
    else pledgedOnly += f.usd;
  }
  return json({
    ok: true,
    donor,
    plan,
    by,
    funded_usd: funded,
    after_usd: after,
    pledged_only_usd: pledgedOnly,
    flows,
    counted,
    source: flowsUrl,
    record: `https://fts.unocha.org/plans/${planId}/summary`,
  });
}
