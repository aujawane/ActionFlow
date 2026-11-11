"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { MobileNav } from "@/components/mobile-nav";
import { ParfaitLogo } from "@/components/parfait-logo";
import { SidebarNav } from "@/components/sidebar-nav";
import { isPublicSitePath } from "@/lib/public-site";

/**
 * The authenticated application chrome (sidebar, top bar, "Add Meeting"). The public site pages
 * (/, /privacy, /terms) bring their own header and footer, so they render without it. Every other
 * route is wrapped exactly as before. `headerActions` is the server-rendered account menu.
 */
export function AppShell({
  headerActions,
  children
}: {
  headerActions: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();

  if (isPublicSitePath(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <SidebarNav />

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-40 border-b border-white/70 bg-white/80 backdrop-blur-xl">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
            <MobileNav />
            <Link href="/" aria-label="Parfait home" className="flex items-center lg:hidden">
              <ParfaitLogo variant="mark" height={28} decorative />
            </Link>
            <div className="ml-auto flex items-center gap-2">
              <Link
                href="/meetings/new"
                className="premium-button px-3 py-1.5 text-xs sm:text-sm"
              >
                Add Meeting
              </Link>
              {headerActions}
            </div>
          </div>
        </header>

        <main className="min-h-[calc(100vh-57px)] px-4 py-6 sm:px-6 sm:py-8">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
