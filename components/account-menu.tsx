"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type AccountMenuProps = {
  fullName: string;
  email: string;
  initials: string;
};

export function AccountMenu({ fullName, email, initials }: AccountMenuProps) {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  async function handleLogout() {
    setLoading(true);
    await supabase.auth.signOut();
    setLoading(false);
    router.push("/login");
    router.refresh();
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open account menu"
        onClick={() => setOpen((current) => !current)}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white shadow-lg shadow-brand-700/20 ring-1 ring-white/60 transition duration-200 hover:-translate-y-0.5 hover:scale-105 hover:bg-brand-700 hover:shadow-brand-700/30 focus:outline-none focus:ring-4 focus:ring-brand-500/20"
      >
        {initials}
      </button>

      <div
        role="menu"
        className={`absolute right-0 z-50 mt-3 w-[min(18rem,calc(100vw-2rem))] origin-top-right overflow-hidden rounded-2xl border border-white/70 bg-white/95 shadow-2xl shadow-slate-900/15 backdrop-blur-xl transition duration-150 ${
          open
            ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
            : "pointer-events-none -translate-y-1 scale-95 opacity-0"
        }`}
      >
        <div className="border-b border-brand-100 bg-gradient-to-br from-brand-50 to-white p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white shadow-lg shadow-brand-700/20">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{fullName}</p>
              <p className="truncate text-xs text-slate-500">{email}</p>
            </div>
          </div>
        </div>

        <div className="p-2">
          <Link
            href="/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 transition hover:-translate-y-0.5 hover:bg-brand-50 hover:text-brand-800"
          >
            Account Settings
          </Link>
          <Link
            href="/account?changePassword=1"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 transition hover:-translate-y-0.5 hover:bg-brand-50 hover:text-brand-800"
          >
            Change Password
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={handleLogout}
            disabled={loading}
            className="w-full rounded-xl px-3 py-2 text-left text-sm font-medium text-rose-600 transition hover:-translate-y-0.5 hover:bg-rose-50 disabled:opacity-60"
          >
            {loading ? "Logging out..." : "Logout"}
          </button>
        </div>
      </div>
    </div>
  );
}
