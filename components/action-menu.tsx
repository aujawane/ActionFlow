"use client";

import { useEffect, useRef, useState } from "react";

export type ActionMenuItem = {
  label: string;
  onSelect: () => void;
  variant?: "default" | "destructive";
  disabled?: boolean;
};

/** Low-noise "•••" overflow trigger, shared by every Phase 6 correction surface (Commitment
 * Workspace task cards/header, Task Workspace, Meeting Detail cards) so the interaction and its
 * accessibility behavior only has to be built once. Renders nothing if there are zero items,
 * so a card never advertises a menu with nothing valid inside it.
 *
 * Follows the WAI-ARIA menu-button pattern: opening focuses the first enabled item, ArrowUp/
 * ArrowDown/Home/End move a roving focus among enabled items only, Escape and an outside click
 * both close and return focus to the trigger, and Tab closes the menu rather than trapping
 * focus inside it. */
export function ActionMenu({
  label,
  items
}: {
  /** Accessible name for the trigger, e.g. "More actions for Draft founder story". */
  label: string;
  items: ActionMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const openFocus = useRef<"first" | "last">("first");

  const enabledIndexes = items
    .map((item, index) => (item.disabled ? -1 : index))
    .filter((index) => index !== -1);

  function focusItemAt(index: number) {
    itemRefs.current[index]?.focus();
  }

  function focusRelative(fromIndex: number, direction: 1 | -1) {
    if (enabledIndexes.length === 0) return;
    const position = enabledIndexes.indexOf(fromIndex);
    const nextPosition =
      position === -1
        ? direction === 1
          ? 0
          : enabledIndexes.length - 1
        : (position + direction + enabledIndexes.length) % enabledIndexes.length;
    focusItemAt(enabledIndexes[nextPosition]);
  }

  useEffect(() => {
    if (!open) return;

    // WAI-ARIA menu-button pattern: opening moves focus into the menu immediately.
    const target =
      openFocus.current === "last"
        ? enabledIndexes[enabledIndexes.length - 1]
        : enabledIndexes[0];
    if (target !== undefined) focusItemAt(target);

    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (items.length === 0) return null;

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openFocus.current = event.key === "ArrowDown" ? "first" : "last";
      setOpen(true);
    }
  }

  function handleItemKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRelative(index, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRelative(index, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      if (enabledIndexes[0] !== undefined) focusItemAt(enabledIndexes[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      if (enabledIndexes.length > 0) focusItemAt(enabledIndexes[enabledIndexes.length - 1]);
    } else if (event.key === "Tab") {
      // Let Tab move focus on to the next element on the page rather than trapping it here.
      setOpen(false);
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative inline-block text-left"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          openFocus.current = "first";
          setOpen((value) => !value);
        }}
        onKeyDown={handleTriggerKeyDown}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
      >
        <span aria-hidden="true" className="text-base leading-none tracking-widest">
          •••
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onKeyDown={(event) => handleItemKeyDown(event, index)}
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
                item.onSelect();
              }}
              className={`block w-full px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
                item.variant === "destructive"
                  ? "text-rose-700 hover:bg-rose-50"
                  : "text-slate-700 hover:bg-brand-50 hover:text-brand-800"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
