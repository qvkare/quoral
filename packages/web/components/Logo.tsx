/**
 * Quoral mark: a whole note read as a "Q". The ink notehead is the quote; the tail is the red-pencil
 * stroke the contract makes when a bar is missed.
 */
export function LogoMark({ size = 26, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <g transform="rotate(-20 29 31)">
        <ellipse cx="29" cy="31" rx="23" ry="16.5" fill="var(--ink, #141414)" />
        <ellipse cx="29" cy="31" rx="10.5" ry="12.5" transform="rotate(48 29 31)" fill="var(--paper, #fafaf7)" />
      </g>
      <path d="M41 44 L57 58" stroke="var(--pencil, #e0452b)" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}
