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

/**
 * Desktop table-of-contents link. Every item reserves the same 2px left bar (transparent when
 * inactive) so the active state changes colour only: no layout shift. The active item is marked by
 * the bar and darker brand text, not colour alone; `aria-current` / `data-active` drive it.
 */
export const tocLink = `block rounded-sm border-l-2 border-transparent py-1 pl-3 font-medium text-slate-600 transition-colors duration-150 hover:text-brand-800 aria-[current=location]:border-brand-700 aria-[current=location]:text-brand-800 ${focusRing}`;
