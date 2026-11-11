import type { Metadata } from "next";

import "@/app/globals.css";
import { AccountMenuServer } from "@/components/account-menu-server";
import { AppShell } from "@/components/app-shell";
import { SOCIAL_IMAGE } from "@/lib/public-site";

export const metadata: Metadata = {
  title: "Parfait",
  description:
    "Parfait turns meeting conversations into commitments, tasks, and completed deliverables.",
  openGraph: { images: [SOCIAL_IMAGE] },
  twitter: { card: "summary_large_image", images: [SOCIAL_IMAGE.url] }
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
