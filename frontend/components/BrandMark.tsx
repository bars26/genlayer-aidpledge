/** AidPledge mark: a sunflower-gold crate on a navy tile, with a check where the gap closes. */
export function BrandMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role="img" aria-label="AidPledge">
      <rect width="32" height="32" rx="9" fill="#14213D" />
      <path d="M7 12.5 16 8l9 4.5v9.5L16 26.5 7 22Z" fill="#F2B33D" />
      <path d="M7 12.5 16 17l9-4.5M16 17v9.5" fill="none" stroke="#14213D" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M11.5 10.2 20.5 14.7" stroke="#14213D" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="24.5" cy="24.5" r="4.6" fill="#F7F4EC" stroke="#14213D" strokeWidth="1.2" />
      <path d="M22.6 24.6l1.3 1.3 2.5-2.7" fill="none" stroke="#2E8B67" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
