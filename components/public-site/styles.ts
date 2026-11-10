/** Class strings shared by the public pages. Focus rings use :focus-visible with a solid outline
 * so keyboard focus is clearly visible, and the primary button uses brand-700 (not brand-600) so
 * white button text meets WCAG AA contrast. */
export const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700";

const buttonBase =
  "inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors duration-200";

export const primaryCta = `${buttonBase} bg-brand-700 text-white shadow-sm hover:bg-brand-800 ${focusRing}`;

export const secondaryCta = `${buttonBase} border border-slate-300 bg-white/80 text-slate-800 hover:border-brand-200 hover:bg-brand-50 hover:text-brand-900 ${focusRing}`;

export const textLink = `rounded-sm font-medium text-slate-700 underline-offset-4 transition-colors hover:text-brand-800 hover:underline ${focusRing}`;

/** Navigation-style text link with a 28px-tall hit area (WCAG 2.5.8 asks for at least 24px). */
export const navLink = `${textLink} inline-block py-1`;
