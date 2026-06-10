import type { Metadata } from "next";
import Link from "next/link";

import "@/app/globals.css";
import { SidebarNav } from "@/components/sidebar-nav";

export const metadata: Metadata = {
  title: "Workflow",
  description:
    "AI-powered meeting companion that turns transcripts into build-ready prompts."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen bg-slate-50">
          <SidebarNav />

          <div className="min-w-0 flex-1">
            <header className="border-b border-slate-200 bg-white">
              <div className="flex items-center justify-between px-4 py-3 sm:px-6">
                <Link href="/" className="text-base font-semibold text-slate-900 lg:hidden">
                  Workflow
                </Link>
                <div className="text-xs text-slate-500 sm:text-sm">
                  AI-powered meeting to engineering workflow
                </div>
                <Link
                  href="/meetings/new"
                  className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 sm:text-sm"
                >
                  New Meeting
                </Link>
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
