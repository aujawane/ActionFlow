"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";

export type NavItem = { href: Route; label: string };

/** The product's two primary destinations -- everything else (meetings, commitments, tasks,
 * deliverables) is reached by drilling into one of these, so the sidebar itself stays this
 * short. Shared with MobileNav so desktop and mobile navigation can never drift apart. */
export const PRIMARY_NAV_ITEMS: NavItem[] = [
  { href: "/projects" as Route, label: "Projects" },
  { href: "/dashboard" as Route, label: "Meetings" }
];

/** Account-level destinations -- visually secondary to the primary product navigation above. */
export const SECONDARY_NAV_ITEMS: NavItem[] = [
  { href: "/account" as Route, label: "Account" },
  { href: "/account/integrations" as Route, label: "Integrations" }
];

const ALL_NAV_ITEMS = [...PRIMARY_NAV_ITEMS, ...SECONDARY_NAV_ITEMS];

/** Only the single most specific matching route counts as active -- without this, "/account"
 * and "/account/integrations" would both read as selected while on the Integrations page,
 * since "/account" is a literal prefix of "/account/integrations". */
export function activeNavHref(pathname: string): Route | undefined {
  const matches = ALL_NAV_ITEMS.filter(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
  ).sort((a, b) => b.href.length - a.href.length);
  return matches[0]?.href;
}

export function SidebarNav() {
  const pathname = usePathname();
  const activeHref = activeNavHref(pathname);

  return (
    <aside className="hidden w-64 shrink-0 border-r border-white/70 bg-white/80 backdrop-blur-xl lg:block">
      <div className="flex h-full flex-col p-5">
        <Link
          href="/"
          className="mb-8 flex items-center gap-3 text-lg font-semibold text-slate-950 transition hover:text-brand-700"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-brand-600 text-sm font-bold text-white shadow-lg shadow-brand-700/20">
            P
          </span>
          <span>Parfait</span>
        </Link>

        <nav className="space-y-1.5">
          {PRIMARY_NAV_ITEMS.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`group block rounded-xl px-3 py-2.5 text-sm font-semibold transition duration-200 ${
                  active
                    ? "bg-brand-600 text-white shadow-lg shadow-brand-700/20"
                    : "text-slate-600 hover:-translate-y-0.5 hover:bg-brand-50 hover:text-brand-800"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto space-y-1 border-t border-slate-100 pt-4">
          {SECONDARY_NAV_ITEMS.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`block rounded-lg px-3 py-2 text-xs font-medium transition ${
                  active
                    ? "bg-brand-50 text-brand-800"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
