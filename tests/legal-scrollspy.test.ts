import "./support/react-global";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PrivacyPolicy, privacySections } from "../components/public-site/privacy-content";
import { TermsOfService, termsSections } from "../components/public-site/terms-content";
import {
  SCROLLSPY_ACTIVATION_OFFSET_PX,
  isScrolledToBottom,
  resolveActiveSectionId
} from "../lib/legal-scrollspy";

const render = (component: (props: { signedIn: boolean }) => unknown) =>
  renderToStaticMarkup(createElement(component as never, { signedIn: false }));

const decode = (html: string) => html.replace(/&#x27;|&#39;/g, "'");

const EXPECTED_PRIVACY_LABELS: Array<[string, string]> = [
  ["summary", "The short version"],
  ["information-we-collect", "Information we collect"],
  ["google-user-data", "Google Sign In"],
  ["how-we-use", "How we use information"],
  ["ai-processing", "AI processing"],
  ["sharing", "Service providers"],
  ["meeting-participants", "Recorded meetings"],
  ["cookies", "Cookies"],
  ["retention", "Data retention"],
  ["choices", "Your choices"],
  ["security", "Security"],
  ["children", "Children's privacy"],
  ["changes", "Policy changes"],
  ["contact", "Contact"]
];

/** The desktop contents list is the sticky <nav>; the mobile one lives inside <details>. */
function desktopNav(html: string) {
  const match = html.match(/<nav aria-label="[^"]*sections" class="hidden lg:sticky[\s\S]*?<\/nav>/);
  assert.ok(match, "desktop nav present");
  return match[0];
}

test("privacy desktop nav shows the shortened labels, in order, linking to the existing section ids", () => {
  const nav = desktopNav(render(PrivacyPolicy));
  const links = [...nav.matchAll(/<a href="#([^"]+)"[^>]*>([^<]*)<\/a>/g)].map(
    (m) => [m[1], decode(m[2])] as [string, string]
  );
  assert.deepEqual(links, EXPECTED_PRIVACY_LABELS);
  assert.deepEqual(
    links.map(([id]) => id),
    privacySections.map((section) => section.id)
  );
});

test("shortening the nav does not change the policy: headings keep their full titles", () => {
  const html = decode(render(PrivacyPolicy));
  for (const section of privacySections) {
    assert.ok(section.navLabel, `${section.id} has a nav label`);
    assert.ok(section.navLabel.length <= 24, `${section.id} label is short enough for one line`);
    assert.ok(
      html.includes(`id="${section.id}-heading" class="text-xl font-semibold tracking-tight text-slate-950">${section.title}</h2>`),
      `${section.id} heading unchanged`
    );
  }
  assert.equal(
    privacySections.find((s) => s.id === "google-user-data")?.title,
    "Google Sign In and Google User Data"
  );
  assert.equal(
    privacySections.find((s) => s.id === "sharing")?.title,
    "Service providers and who we share with"
  );
});

test("exactly one item is marked current, with aria-current and a non-colour cue", () => {
  const nav = desktopNav(render(PrivacyPolicy));
  assert.equal((nav.match(/aria-current="location"/g) ?? []).length, 1);
  assert.equal((nav.match(/data-active="true"/g) ?? []).length, 1);
  assert.match(nav, /<a href="#summary" aria-current="location"/);
  // Every item reserves the same left bar (transparent when inactive), so nothing shifts.
  assert.equal((nav.match(/border-l-2 border-transparent/g) ?? []).length, 14);
  assert.match(nav, /aria-\[current=location\]:border-brand-700/);
  assert.match(nav, /focus-visible:outline-2/);
  assert.doesNotMatch(nav, /whitespace-nowrap|truncate|text-ellipsis/);
});

test("terms shares the component but keeps its full section titles", () => {
  const nav = desktopNav(decode(render(TermsOfService)));
  for (const section of termsSections) {
    assert.ok(nav.includes(`href="#${section.id}"`));
    assert.ok(nav.includes(`>${section.title}</a>`), `${section.id} keeps its title`);
    assert.equal(section.navLabel, undefined);
  }
});

test("the mobile contents list keeps the full titles and has no scrollspy state", () => {
  const html = decode(render(PrivacyPolicy));
  const details = html.match(/<details[\s\S]*?<\/details>/)?.[0] ?? "";
  assert.match(details, /Google Sign In and Google User Data/);
  assert.doesNotMatch(details, /aria-current/);
});

// ------------------------------------------------------------------ scrollspy rule
const IDS = ["a", "b", "c"] as const;
const at = (tops: [number, number, number], atBottom = false) =>
  resolveActiveSectionId({ sections: IDS.map((id, i) => ({ id, top: tops[i] })), atBottom });

test("before the first section is reached, the first section is active", () => {
  assert.equal(at([600, 1200, 1800]), "a");
});

test("the last section whose top has reached the activation line is active", () => {
  const line = SCROLLSPY_ACTIVATION_OFFSET_PX;
  assert.equal(at([line, 900, 1500]), "a");
  assert.equal(at([-300, line, 900]), "b");
  assert.equal(at([-900, -200, line - 1]), "c");
  assert.equal(at([-300, line + 1, 900]), "a");
});

test("one section is active at a time and the answer does not depend on scroll direction", () => {
  const result = (scrollY: number) => at([300 - scrollY, 1100 - scrollY, 1900 - scrollY]);
  const positions = Array.from({ length: 60 }, (_, i) => i * 50);
  const down = positions.map((y) => result(y) as string);
  const up = [...positions].reverse().map((y) => result(y) as string).reverse();
  assert.deepEqual(down, up);
  assert.deepEqual([...new Set(down)], ["a", "b", "c"]);
  const order = ["a", "b", "c"];
  for (let i = 1; i < down.length; i++) {
    assert.ok(order.indexOf(down[i]) >= order.indexOf(down[i - 1]), "never steps backwards going down");
  }
});

test("at the bottom of the page the final section stays active even if it can't reach the line", () => {
  assert.equal(at([-900, -400, 500], true), "c");
  assert.equal(at([-900, -400, 500], false), "b");
});

test("a deep link resolves from positions alone: the browser has already scrolled to the hash", () => {
  // #b scrolled to the top with scroll-mt-6 (24px) -> b is active on load.
  assert.equal(at([-700, 24, 650]), "b");
});

test("no sections gives no active id", () => {
  assert.equal(resolveActiveSectionId({ sections: [], atBottom: false }), null);
  assert.equal(resolveActiveSectionId({ sections: [], atBottom: true }), null);
});

test("isScrolledToBottom tolerates sub-pixel rounding only", () => {
  assert.equal(isScrolledToBottom({ scrollY: 1000, viewportHeight: 800, documentHeight: 1800 }), true);
  assert.equal(isScrolledToBottom({ scrollY: 999.4, viewportHeight: 800, documentHeight: 1800 }), true);
  assert.equal(isScrolledToBottom({ scrollY: 990, viewportHeight: 800, documentHeight: 1800 }), false);
});
