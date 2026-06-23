import type { Metadata } from "next";
import Link from "next/link";

import "@/app/globals.css";
import { AccountMenuServer } from "@/components/account-menu-server";
import { SidebarNav } from "@/components/sidebar-nav";

export const metadata: Metadata = {
  title: "Parfait",
  description:
    "AI-powered meeting companion that turns transcripts into build-ready prompts."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <SidebarNav />

          <div className="min-w-0 flex-1">
            <header className="sticky top-0 z-40 border-b border-white/70 bg-white/80 backdrop-blur-xl">
              <div className="flex items-center justify-between px-4 py-3 sm:px-6">
                <Link
                  href="/"
                  className="text-base font-semibold text-slate-950 transition hover:text-brand-700 lg:hidden"
                >
                  Parfait
                </Link>
                <div className="hidden rounded-full border border-brand-100 bg-brand-50/80 px-3 py-1 text-xs font-medium text-brand-800 sm:block">
                  AI-powered meetings to engineering plans
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    href="/meetings/new"
                    className="premium-button px-3 py-1.5 text-xs sm:text-sm"
                  >
                    New Meeting
                  </Link>
                  <AccountMenuServer />
                </div>
              </div>
            </header>

            <main className="min-h-[calc(100vh-57px)] px-4 py-6 sm:px-6 sm:py-8">
              <div className="mx-auto w-full max-w-7xl">{children}</div>
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
