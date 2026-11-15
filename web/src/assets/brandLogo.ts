/**
 * t3code-proxy brand: wordmark and logo mark.
 *
 * The mark is three account lanes merging into one hub node — many
 * credentials, one proxy. Inlined as an SVG data URI so the single-file build
 * stays self-contained.
 */

export const BRAND_NAME = 't3code-proxy';

export const BRAND_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="8" fill="#141414"/>
<rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#2c2c2c"/>
<path d="M7 9.5h4.5l5 6.5M7 16h9.5M7 22.5h4.5l5-6.5" fill="none" stroke="#f4f4f5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="22.5" cy="16" r="3.6" fill="#ec4899"/>
</svg>`;

export const BRAND_LOGO_URI = `data:image/svg+xml,${encodeURIComponent(BRAND_LOGO_SVG)}`;
