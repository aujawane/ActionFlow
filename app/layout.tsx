import type { Metadata } from "next";
import Link from "next/link";

import "@/app/globals.css";

export const metadata: Metadata = {
  title: "ActionFlow",
  description:
    "AI-powered meeting companion that turns transcripts into build-ready prompts."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="text-lg font-semibold text-slate-900">
              ActionFlow
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              <Link href="/dashboard">Dashboard</Link>
              <Link href="/meetings/new">New Meeting</Link>
              <Link href="/login">Login</Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto min-h-[calc(100vh-65px)] max-w-6xl px-6 py-10">
          {children}
        </main>
      </body>
    </html>
  );
}
