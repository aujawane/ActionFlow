"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Minimal, dependency-free modal shell shared by every Phase 6 correction dialog (confirmations,
 * the move-to-commitment picker, the report-extraction form). Escape and an outside click both
 * cancel; the caller owns the interactive content, but focus placement/trapping/restoration and
 * background scroll-lock are handled once, here, so every dialog gets the same behavior. */
export function Modal({
  open,
  title,
  onClose,
  children,
  variant = "dialog"
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** "dialog" (default): centered card, used by every confirmation/form dialog. "drawer": panel
   * pinned to the left edge, full height -- reused by MobileNav so the slide-over gets the same
   * focus trap/scroll-lock/Escape/restoration behavior without duplicating it. */
  variant?: "dialog" | "drawer";
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    // Initial focus: WAI-ARIA dialog pattern -- move focus into the dialog itself (rather than
    // guessing which inner control matters most across very different dialog bodies) so
    // keyboard/AT users land inside it immediately, and remember what had focus so it can be
    // restored below regardless of which path (Escape, outside click, Cancel, Confirm) closes it.
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialogRef.current.contains(active)) {
        // Focus somehow ended up outside the dialog (e.g. a programmatic focus call elsewhere) --
        // pull it back in rather than letting Tab continue into the page behind the overlay.
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  if (variant === "drawer") {
    return (
      <div
        className="fixed inset-0 z-50 flex items-stretch justify-start bg-slate-950/40"
        onClick={onClose}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          className="h-full w-72 max-w-[80vw] overflow-y-auto bg-white p-5 shadow-2xl outline-none"
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl outline-none sm:p-6"
      >
        {children}
      </div>
    </div>
  );
}

export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex flex-wrap justify-end gap-2">{children}</div>;
}
