import type { Metadata } from "next";

import "@/app/globals.css";
import { AccountMenuServer } from "@/components/account-menu-server";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Parfait",
  description:
    "Parfait turns meeting conversations into commitments, tasks, and completed deliverables."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <AppShell headerActions={<AccountMenuServer />}>{children}</AppShell>
      </body>
    </html>
  );
}
