/** Types and display helpers for the AidPledge contract. */

export type Verdict = "BREACHED" | "KEPT" | "UNCLEAR";
type Num = string | number | bigint;

export interface Pledge {
  id: string;
  pledger: string;
  donor_id: string;
  donor_name: string;
  plan_id: string;
  plan_json: string;
  target_usd: Num;
  deadline: string;
  announcement_json: string;
  payout: Num;
  beneficiary: string;
  expires: string;
  state: "active" | "closed";
  bond: Num;
  total_bonded: Num;
  total_paid: Num;
  stakes_kept: Num;
  pending: Num;
  outcome: "" | "kept" | "paid";
  claim_ids_json: string;
  n_breached: Num;
  n_kept: Num;
  n_other: Num;
  history_json: string;
}

export interface Claim {
  id: string;
  pledge_id: string;
  claimant: string;
  stake: Num;
  filed_at: string;
  window_from: string;
  state: "pending" | "settled";
  verdict: Verdict;
  code: string;
  facts_json: string;
  evidence_json: string;
  why: string;
  pledger_contested: boolean;
  claimant_contested: boolean;
  outcome: "" | "paid" | "stake_returned" | "stake_to_bond";
  timeline_json: string;
}

/** A response plan as frozen when the pledge was made. */
export interface Plan {
  name: string;
  code: string;
  start: string;
  end: string;
  locations: string[];
}

/** The donor's announcement as validators read it at pledging. */
export interface Announcement {
  url: string;
  sha256: string;
  chars: number;
  excerpt: string;
  answer: "MATCH" | "NO_MATCH" | "UNCLEAR";
}

/** What every validator read and agreed on for a ruling. */
export interface ClaimFacts {
  donor?: string;
  plan?: string;
  deadline?: string;
  target_usd?: number;
  funded_usd?: number;
  flows_counted?: number;
  after_deadline_usd?: number;
  pledged_only_usd?: number;
  shortfall_usd?: number;
  shortfall_bp?: number;
}

/** One FTS flow, as the contract stores it. */
export interface Flow {
  id: string;
  status: string;
  date: string;
  usd: number;
  reported: string;
}

/** One reading's evidence packet: the exact FTS flows validators read, with hashes. */
export interface EvidencePacket {
  source?: string;
  record?: string;
  flows?: Flow[];
  flows_total?: number;
  flows_sha256?: string;
  fts_total_incoming?: number;
  read_at?: string;
  packet_sha256?: string;
}

/** What /api/funding reports for a donor, a plan and a date: the same reading the contract makes. */
export interface FundingLookup {
  ok: boolean;
  error?: string;
  donor?: { id: string; name: string } | null;
  plan?: ({ id: string } & Plan) | null;
  by?: string;
  funded_usd?: number;
  after_usd?: number;
  pledged_only_usd?: number;
  flows?: Flow[];
  counted?: number;
  source?: string;
  record?: string;
}

export interface TimelineStep {
  at: string;
  event: "filed" | "contested" | "settled";
  by?: string;
  before?: string;
  verdict?: string;
  code?: string;
  outcome?: string;
  amount?: string;
  beneficiary?: string;
  reporter?: string;
  share_bp?: number;
  evidence?: string;
}

export const RESPONSE_WINDOW_SECONDS = 600;
export const MIN_PAYOUT_WEI = 10n ** 18n;
export const MIN_TARGET_USD = 1000;
export const REPORTING_LAG_DAYS = 30;
export const REPORT_DAYS = 30;
export const FUNDED = ["commitment", "paid"];

/** Donors and 2025 response plans with known FTS ids, for the pickers. Any other id can be typed in. */
export const DONORS = [
  { id: "2917", name: "United Kingdom" },
  { id: "2933", name: "United States" },
  { id: "4306", name: "Germany" },
  { id: "8523", name: "European Commission (ECHO)" },
  { id: "2998", name: "Saudi Arabia" },
  { id: "2928", name: "Canada" },
];
export const PLANS = [
  { id: "1220", name: "Sudan 2025" },
  { id: "1262", name: "Yemen 2025" },
  { id: "1263", name: "Afghanistan 2025" },
  { id: "1271", name: "Ukraine 2025" },
  { id: "1257", name: "Haiti 2025" },
  { id: "1223", name: "South Sudan 2025" },
  { id: "1275", name: "Myanmar 2025" },
  { id: "1286", name: "Lebanon flash appeal 2025" },
];

export function wei(v: Num | undefined): bigint {
  try {
    return BigInt(String(v ?? "0").split(".")[0]);
  } catch {
    return 0n;
  }
}

export function formatGen(v: Num | undefined, digits = 2): string {
  const n = Number(wei(v)) / 1e18;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function parseGen(input: string): bigint | null {
  const t = input.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
}

/** $141.1M style, for headlines; usdFull for exact figures. */
export function usd(n: Num | undefined): string {
  const v = Number(n ?? 0);
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
export const usdFull = (n: Num | undefined) => `$${Number(n ?? 0).toLocaleString("en-US")}`;

export function parseJson<T>(json: string | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function utcMs(iso: string): number {
  if (!iso) return NaN;
  const t = iso.trim();
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`);
}

export function windowLeftSeconds(claim: Claim, now = Date.now()): number {
  return Math.max(0, Math.ceil(RESPONSE_WINDOW_SECONDS - (now - utcMs(claim.window_from)) / 1000));
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const factsOf = (c: Claim) => parseJson<ClaimFacts>(c.facts_json, {});
export const timelineOf = (c: Claim) => parseJson<TimelineStep[]>(c.timeline_json, []);
export const evidenceOf = (c: Claim) => parseJson<EvidencePacket[]>(c.evidence_json, []);
export const planOf = (p: Pledge) => parseJson<Plan>(p.plan_json, { name: p.plan_id, code: "", start: "", end: "", locations: [] });
export const announcementOf = (p: Pledge) => parseJson<Announcement | null>(p.announcement_json, null);
export const stakeFor = (p: Pledge) => wei(p.payout) / 10n;
/** The first day a claim can be filed: FTS needs time to record funding dated up to the deadline. */
export const claimsOpen = (p: Pick<Pledge, "deadline">) => addDays(p.deadline, REPORTING_LAG_DAYS);
export const ftsPlanUrl = (planId: string) => `https://fts.unocha.org/plans/${planId}/summary`;
export const shortName = (donor: string) => donor.replace(/, Government of$/, "");

/** What a pledge still guarantees; same rule as the contract's coverage(). */
export function coverageOf(p: Pledge) {
  const liability = p.state === "active" && !p.outcome ? wei(p.payout) : 0n;
  return { liability, covered: wei(p.bond) >= liability };
}

export const VERDICT_STYLE: Record<Verdict, { label: string; cls: string; help: string }> = {
  BREACHED: {
    label: "Fell short",
    cls: "bg-[#F9E1DA] text-[#9A3220] border-[#EFC0B3]",
    help: "The bond pays the beneficiary in proportion to the shortfall, and the reporter gets 10% of it.",
  },
  KEPT: {
    label: "Delivered",
    cls: "bg-[#DCEFE6] text-[#1E6A4E] border-[#B3DCC8]",
    help: "The target was met. The reporter's stake goes to the bond.",
  },
  UNCLEAR: {
    label: "Undecided",
    cls: "bg-[#FDF0D2] text-[#86580A] border-[#F2DBA2]",
    help: "OCHA FTS could not be read. Nothing is decided and the stake comes back.",
  },
};

export const OUTCOME_TEXT: Record<string, string> = {
  paid: "Paid from the bond",
  stake_returned: "Stake returned to the reporter",
  stake_to_bond: "Stake added to the bond",
};

export const CODE_LABEL: Record<string, string> = {
  met: "target met",
  shortfall: "below target",
  unreachable: "FTS unreachable",
  incomplete: "FTS list incomplete",
};
