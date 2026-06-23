"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";

const navItems = [
  { href: "/dashboard" as Route, label: "Dashboard" },
  { href: "/meetings/new" as Route, label: "New Meeting" },
  { href: "/account" as Route, label: "Account" }
];

export function SidebarNav() {
  const pathname = usePathname();

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
          {navItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
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

        <div className="mt-auto rounded-2xl border border-brand-100 bg-gradient-to-br from-brand-50 to-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">Parfait AI</p>
          <p className="mt-2 text-xs leading-5 text-slate-600">
            Turn meetings into build-ready implementation prompts.
          </p>
        </div>
      </div>
    </aside>
  );
}
