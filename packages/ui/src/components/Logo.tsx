// Brand mark — SVG recreation of the Aiployee app icon (person glyph on a dark
// rounded square). Swap for the official asset by dropping it in web/public and
// replacing this with an <img>. viewBox is square; `size` controls render size.
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Aiployee">
      <rect width="64" height="64" rx="16" fill="#1a0f3d" />
      <circle cx="32" cy="25" r="8.5" fill="url(#aip-head)" />
      <path d="M17 49c0-8.3 6.7-13 15-13s15 4.7 15 13v3H17z" fill="url(#aip-body)" />
      <path d="M23 39l18 11M41 39L23 50" stroke="#1a0f3d" strokeWidth="3.2" strokeLinecap="round" opacity="0.55" />
      <defs>
        <linearGradient id="aip-head" x1="23.5" y1="16.5" x2="40.5" y2="33.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d146ff" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
        <linearGradient id="aip-body" x1="17" y1="36" x2="47" y2="52" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7c3aed" />
          <stop offset="1" stopColor="#5b3df5" />
        </linearGradient>
      </defs>
    </svg>
  );
}
