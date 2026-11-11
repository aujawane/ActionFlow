"use client";

import { useEffect, useState } from "react";

import { tocLink } from "@/components/public-site/styles";
import {
  isScrolledToBottom,
  resolveActiveSectionId,
  type SectionPosition
} from "@/lib/legal-scrollspy";

export type LegalNavItem = { id: string; label: string };

/**
 * Desktop "On this page" navigation with scrollspy. Server markup renders the first section as
 * current; after mount the real position (including a #hash deep link) takes over. Mobile uses the
 * collapsed <details> list in legal-document.tsx instead, which has no scrollspy.
 */
export function LegalSectionNav({ title, items }: { title: string; items: LegalNavItem[] }) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    let frame = 0;

    function update() {
      frame = 0;
      const positions: SectionPosition[] = [];
      for (const item of items) {
        const element = document.getElementById(item.id);
        if (element) positions.push({ id: item.id, top: element.getBoundingClientRect().top });
      }
      const next = resolveActiveSectionId({
        sections: positions,
        atBottom: isScrolledToBottom({
          scrollY: window.scrollY,
          viewportHeight: window.innerHeight,
          documentHeight: document.documentElement.scrollHeight
        })
      });
      setActiveId((current) => (next && next !== current ? next : current));
    }

    // One recompute per frame, however many scroll events fire.
    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(update);
    }

    update(); // correct on first paint, including deep links (the browser has scrolled to the hash)
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
    };
  }, [items]);

  function onNavigate(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    // Let the browser handle modified clicks (new tab, etc.).
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = document.getElementById(id);
    if (!target) return; // fall back to the normal anchor jump
    event.preventDefault();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The section's scroll-mt class keeps its heading clear of the top edge.
    target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    window.history.pushState(null, "", `#${id}`);
    setActiveId(id);
  }

  return (
    <nav aria-label={`${title} sections`} className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">On this page</p>
      <ol className="mt-3 text-sm">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={active ? "location" : undefined}
                data-active={active ? "true" : undefined}
                onClick={(event) => onNavigate(event, item.id)}
                className={tocLink}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
