/**
 * t3code-proxy brand: wordmark, app icon and fox mark.
 *
 * Both SVGs are imported as text and inlined as data URIs so the single-file
 * build stays self-contained. Do not redraw the mascot; edit the files in
 * ./brand instead.
 */

import iconSvg from './brand/icon.svg?raw';
import foxSvg from './brand/fox.svg?raw';

export const BRAND_NAME = 't3code-proxy';

const toDataUri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;

/** Glossy black tile with the fox: sidebar brand row, favicon. */
export const BRAND_LOGO_URI = toDataUri(iconSvg);

/** Bare fox mark (reads on light and dark): login screen. */
export const BRAND_FOX_URI = toDataUri(foxSvg);
