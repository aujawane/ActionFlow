"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Modal } from "@/components/modal";
import { activeNavHref, PRIMARY_NAV_ITEMS, SECONDARY_NAV_ITEMS } from "@/components/sidebar-nav";

/** Below the desktop sidebar's `lg` breakpoint, Projects/Meetings/Account/Integrations were only
 * reachable by typing a URL -- the sidebar is `hidden` and the mobile header never carried an
 * equivalent. This is the simplest robust fix: a hamburger trigger that opens the same nav items
 * in a Modal "drawer", reusing its existing focus trap/scroll-lock/Escape/restoration behavior. */
export function MobileNav() {
  const pathname = usePathname();
  const activeHref = activeNavHref(pathname);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Open navigation menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 lg:hidden"
      >
        <span aria-hidden="true" className="flex flex-col gap-1">
          <span className="block h-0.5 w-5 rounded-full bg-current" />
          <span className="block h-0.5 w-5 rounded-full bg-current" />
          <span className="block h-0.5 w-5 rounded-full bg-current" />
        </span>
      </button>

      <Modal open={open} title="Navigation" onClose={() => setOpen(false)} variant="drawer">
        <div className="flex items-center gap-3 pb-6">
          <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-brand-600 text-sm font-bold text-white shadow-lg shadow-brand-700/20">
            P
          </span>
          <span className="text-lg font-semibold text-slate-950">Parfait</span>
        </div>

        <nav className="space-y-1.5">
          {PRIMARY_NAV_ITEMS.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={`block rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                  active
                    ? "bg-brand-600 text-white shadow-lg shadow-brand-700/20"
                    : "text-slate-600 hover:bg-brand-50 hover:text-brand-800"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-6 space-y-1 border-t border-slate-100 pt-4">
          {SECONDARY_NAV_ITEMS.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
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
      </Modal>
    </>
  );
}
