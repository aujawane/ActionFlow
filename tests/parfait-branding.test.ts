import "./support/react-global";

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ParfaitLogo } from "../components/parfait-logo";
import { HomePage } from "../components/public-site/home-page";
import { SOCIAL_IMAGE, SITE_URL } from "../lib/public-site";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const exists = (path: string) => access(new URL(`../${path}`, import.meta.url)).then(() => true, () => false);
const logo = (props: Parameters<typeof ParfaitLogo>[0]) => renderToStaticMarkup(createElement(ParfaitLogo, props));

test("the logo keeps the approved brand colours, proportions and accessible names", () => {
  const full = logo({});
  assert.match(full, /fill="#079668"/);
  assert.match(full, /viewBox="0 0 1078 288"/);
  assert.match(full, /role="img" aria-label="Parfait"/);
  assert.match(logo({ color: "white" }), /fill="#FFFFFF"/);

  const mark = logo({ variant: "mark", height: 28 });
  assert.match(mark, /viewBox="0 0 288 288"/);
  assert.match(mark, /width="28" height="28"/);

  const decorative = logo({ decorative: true });
  assert.match(decorative, /aria-hidden="true"/);
  assert.doesNotMatch(decorative, /aria-label|role=/);
  // Aspect ratio is preserved at every size.
  assert.match(logo({ height: 32 }), /width="119\.77\d*" height="32"/);
});

test("the old letter-P tile is gone from every brand placement", async () => {
  for (const file of [
    "components/sidebar-nav.tsx",
    "components/mobile-nav.tsx",
    "components/public-site/site-header.tsx",
    "components/app-shell.tsx",
    "components/auth-form.tsx"
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /bg-brand-[67]00 text-sm font-bold/, `${file}: no P tile`);
    assert.match(source, /ParfaitLogo/, `${file} uses the logo component`);
  }
  assert.match(await read("components/auth-form.tsx"), /<ParfaitLogo color="white"/, "dark panel uses white");
  assert.match(await read("components/app-shell.tsx"), /variant="mark"/, "compact top bar uses the cup alone");
});

test("the public header shows the green logo in a labelled home link", () => {
  const html = renderToStaticMarkup(createElement(HomePage as never, { signedIn: false }));
  const header = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.match(header, /<a[^>]*aria-label="Parfait home"[^>]*href="\/"|<a[^>]*href="\/"[^>]*aria-label="Parfait home"/);
  assert.match(header, /<svg[^>]*fill="#079668"/);
  assert.doesNotMatch(header, />P</);
});

test("brand, icon and app-icon files are present and the manifest only references real files", async () => {
  for (const file of [
    "public/brand/parfait-logo-green.svg",
    "public/brand/parfait-logo-white.svg",
    "public/brand/parfait-mark-green.svg",
    "public/brand/parfait-social-1200x630.png",
    "public/icons/apple-touch-icon.png",
    "public/icons/icon-192.png",
    "public/icons/icon-512.png",
    "public/icons/icon-maskable-512.png",
    "app/favicon.ico",
    "app/icon.svg",
    "app/apple-icon.png"
  ]) {
    assert.ok(await exists(file), file);
  }
  const manifest = JSON.parse(await read("app/manifest.webmanifest")) as {
    name: string;
    theme_color: string;
    icons: Array<{ src: string }>;
  };
  assert.equal(manifest.name, "Parfait");
  assert.equal(manifest.theme_color, "#079668");
  for (const icon of manifest.icons) assert.ok(await exists(`public${icon.src}`), icon.src);
  // Only one icon / manifest definition per kind (no stale duplicates).
  for (const stale of ["app/icon.png", "app/icon.ico", "app/apple-icon.svg", "app/manifest.ts", "app/manifest.json"]) {
    assert.ok(!(await exists(stale)), `${stale} must not coexist`);
  }
});

test("social image uses the existing site URL and is wired into the existing metadata", async () => {
  assert.equal(SOCIAL_IMAGE.url, `${SITE_URL}/brand/parfait-social-1200x630.png`);
  assert.deepEqual([SOCIAL_IMAGE.width, SOCIAL_IMAGE.height], [1200, 630]);
  for (const file of ["app/page.tsx", "app/privacy/page.tsx", "app/terms/page.tsx", "app/layout.tsx"]) {
    assert.match(await read(file), /SOCIAL_IMAGE/, file);
  }
});
