import { useId } from "react";

/**
 * Quoral mark: a whole note read as a "Q". The ink notehead is the quote; the tail is the red-pencil
 * stroke the contract makes when a bar is missed. A thin gap is cut out of the note around the tail, so the
 * stroke reads as drawn over the note on any background.
 */
export function LogoMark({ size = 26, title }: { size?: number; title?: string }) {
  const cut = `qcut-${useId().replace(/:/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <mask id={cut} maskUnits="userSpaceOnUse" x="-10" y="-10" width="84" height="84">
          <rect x="-10" y="-10" width="84" height="84" fill="#fff" />
          <g transform="rotate(-20 29 31)">
            <ellipse cx="29" cy="31" rx="10.5" ry="12.5" transform="rotate(48 29 31)" fill="#000" />
          </g>
          <path d="M41 44 L57 58" stroke="#000" strokeWidth="10.2" strokeLinecap="round" />
        </mask>
      </defs>
      <g mask={`url(#${cut})`}>
        <ellipse cx="29" cy="31" rx="23" ry="16.5" transform="rotate(-20 29 31)" fill="var(--ink, #141414)" />
      </g>
      <path d="M41 44 L57 58" stroke="var(--pencil, #e0452b)" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}
