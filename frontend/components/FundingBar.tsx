import { usd, usdFull } from "@/lib/contracts/types";

/**
 * Funding recorded by the deadline against the pledged target. The bar is scaled so the target
 * line always shows, even when funding overshoots it.
 */
export function FundingBar({ funded, target, after = 0, compact = false }: { funded: number; target: number; after?: number; compact?: boolean }) {
  const scale = Math.max(target, funded + after, 1) * 1.04;
  const pct = (n: number) => `${Math.min(100, (n / scale) * 100)}%`;
  const met = target > 0 && funded >= target;
  const share = target > 0 ? Math.min(999, (funded / target) * 100) : 0;
  return (
    <div className="space-y-1.5">
      {!compact && (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p>
            <span className="display text-3xl">{usd(funded)}</span>
            <span className="text-sm text-muted-foreground"> of {usd(target)} target</span>
          </p>
          <span className={`text-sm font-semibold ${met ? "text-[#1E6A4E]" : "text-[#9A3220]"}`}>
            {met ? `target met · ${share.toFixed(1)}% funded` : `${usd(target - funded)} short · ${share.toFixed(1)}% funded`}
          </span>
        </div>
      )}
      <div className="relative h-4 rounded-full bg-[#E9E3D3] overflow-hidden" role="img" aria-label={`${usdFull(funded)} of ${usdFull(target)}`}>
        <div className="absolute inset-y-0 left-0 bg-[#F2B33D]" style={{ width: pct(funded) }} />
        {after > 0 && <div className="absolute inset-y-0 bar-late" style={{ left: pct(funded), width: pct(after) }} title="dated after the deadline: does not count" />}
        <div className="absolute inset-y-[-2px] w-[3px] bg-[#14213D]" style={{ left: `calc(${pct(target)} - 1px)` }} title={`target ${usdFull(target)}`} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-3 rounded-sm bg-[#F2B33D]" /> committed or paid by the deadline
        </span>
        {after > 0 && (
          <span className="flex items-center gap-1">
            <i className="inline-block h-2 w-3 rounded-sm bar-late" /> later: {usd(after)}, not counted
          </span>
        )}
        <span className="flex items-center gap-1">
          <i className="inline-block h-2.5 w-[3px] bg-[#14213D]" /> target {usd(target)}
        </span>
      </div>
    </div>
  );
}
