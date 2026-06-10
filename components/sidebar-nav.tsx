"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/meetings/new", label: "New Meeting" },
  { href: "/login", label: "Auth" }
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:block">
      <div className="flex h-full flex-col p-5">
        <Link href="/" className="mb-8 text-lg font-semibold text-slate-900">
          Workflow
        </Link>

        <nav className="space-y-1">
          {navItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-md px-3 py-2 text-sm font-medium transition ${
                  active
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-medium text-slate-700">Workflow AI</p>
          <p className="mt-1 text-xs text-slate-500">
            Turn meetings into build-ready implementation prompts.
          </p>
        </div>
      </div>
    </aside>
  );
}
