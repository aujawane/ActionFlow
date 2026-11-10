import "./support/react-global";

import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { PrivacyPolicy } from "../components/public-site/privacy-content";
import { PRIMARY_NAV_ITEMS, SECONDARY_NAV_ITEMS } from "../components/sidebar-nav";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const exists = (path: string) => access(new URL(path, root)).then(() => true, () => false);

/** Every active (non-test, non-migration, non-doc) source file. */
async function activeSource() {
  const files: Array<{ path: string; source: string }> = [];
  for (const dir of ["app", "lib", "components", "scripts"]) {
    let entries: string[] = [];
    try {
      entries = (await readdir(new URL(`${dir}/`, root), { recursive: true })) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (/\.(ts|tsx)$/.test(entry)) files.push({ path: `${dir}/${entry}`, source: await read(`${dir}/${entry}`) });
    }
  }
  return files;
}

// =============================================================== [1][2] Google Sign In unchanged
test("[1] Google Sign In is still the Supabase OAuth flow and returns through /api/auth/callback", async () => {
  const form = await read("components/auth-form.tsx");
  const call = form.match(/signInWithOAuth\(\{[\s\S]*?\n {4}\}\);/);
  assert.ok(call, "signInWithOAuth call present");
  assert.match(call![0], /provider: "google"/);
  assert.match(call![0], /redirectTo: `\$\{window\.location\.origin\}\/api\/auth\/callback\?next=\$\{encodeURIComponent\(\s*nextPath\s*\)\}`/);
  assert.match(form, /Continue with Google/);
  assert.match(form, /onClick=\{continueWithGoogle\}/);
  assert.ok(await exists("app/api/auth/callback/route.ts"));
  assert.match(await read("app/api/auth/callback/route.ts"), /completeAuthCallback\(\{/);
});

test("[2] standard Google Sign In requests no scopes at all, and so no Meet API scope", async () => {
  const form = await read("components/auth-form.tsx");
  const call = form.match(/signInWithOAuth\(\{[\s\S]*?\n {4}\}\);/)![0];
  assert.doesNotMatch(call, /scopes|queryParams|meetings|googleapis/);
  // No active code builds a Google authorization URL of its own: sign-in goes through Supabase only.
  for (const { path, source } of await activeSource()) {
    assert.doesNotMatch(source, /accounts\.google\.com\/o\/oauth2/, path);
    assert.doesNotMatch(source, /oauth2\.googleapis\.com/, path);
  }
});

test("meetings.space.created and the Meet API are referenced nowhere in active code", async () => {
  for (const { path, source } of await activeSource()) {
    assert.doesNotMatch(source, /meetings\.space/, path);
    assert.doesNotMatch(source, /meet\.googleapis\.com/, path);
    assert.doesNotMatch(source, /GOOGLE_OAUTH_SCOPES|GOOGLE_MEET_SCOPE|createGoogleOAuthUrl|exchangeGoogleAuthorizationCode/, path);
    assert.doesNotMatch(source, /GOOGLE_(CLIENT_ID|CLIENT_SECRET|REDIRECT_URI|REFRESH_TOKEN)/, path);
  }
});

// =============================================================== [3] no user-facing exposure
test("[3] no navigation or page exposes the Google Meet integration", async () => {
  const labels = [...PRIMARY_NAV_ITEMS, ...SECONDARY_NAV_ITEMS].map((item) => item.label);
  assert.deepEqual(labels, ["Projects", "Meetings", "Account"]);
  assert.ok(![...PRIMARY_NAV_ITEMS, ...SECONDARY_NAV_ITEMS].some((item) => /integrations/.test(item.href)));

  // The mobile menu renders the same shared lists, so it cannot drift from the sidebar.
  const mobile = await read("components/mobile-nav.tsx");
  assert.match(mobile, /PRIMARY_NAV_ITEMS, SECONDARY_NAV_ITEMS/);
  assert.doesNotMatch(mobile, /integrations/i);

  for (const { path, source } of await activeSource()) {
    assert.doesNotMatch(source, /account\/integrations/, path);
    assert.doesNotMatch(source, /Start Google Meet|Required for Start|Connect Google|Reconnect Google|Google Meet connected/, path);
    assert.doesNotMatch(source, />\s*Integrations\s*</, path);
  }
  assert.equal(await exists("app/account/integrations/page.tsx"), false);
  assert.equal(await exists("components/integrations-settings-client.tsx"), false);
});

// =============================================================== [4] endpoint cannot initiate OAuth
test("[4] the integration start, callback, status and disconnect endpoints no longer exist", async () => {
  for (const path of [
    "app/api/integrations/google/start/route.ts",
    "app/api/integrations/google/callback/route.ts",
    "app/api/integrations/google/route.ts",
    "app/api/integrations/route.ts",
    "lib/google-integration.ts"
  ]) {
    assert.equal(await exists(path), false, `${path} must be gone`);
  }
  const apiDirs = await readdir(new URL("app/api/", root));
  assert.ok(!apiDirs.includes("integrations"), "no /api/integrations route tree remains");
  // Nothing in the application reads or writes the legacy token table any more.
  for (const { path, source } of await activeSource()) {
    assert.doesNotMatch(source, /user_integrations|UserIntegration/, path);
  }
});

// =============================================================== [5] privacy policy
test("[5] the Privacy Policy no longer claims Parfait uses Google Meet data", () => {
  const html = renderToStaticMarkup(createElement(PrivacyPolicy as never, { signedIn: false }));
  const body = html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ");
  for (const gone of [
    /meetings\.space/, /Start Google Meet/, /Connecting Google Meet/, /Connect Google/, /Integrations page/,
    /refresh token/i, /access token/i, /Google tokens/i, /create Google Meet meeting spaces/i, /Google Meet data/i
  ]) {
    assert.doesNotMatch(body, gone, String(gone));
  }
  // Sign-in disclosure retained.
  assert.match(body, /Google Sign In and Google User Data/);
  assert.match(body, /your name, email address, profile picture and Google account identifier/);
  assert.match(body, /We request no additional Google API scopes for sign-in/);
  // The only remaining mention of the old connection states that it is not used.
  const mentions = body.match(/[^.]*Google Meet[^.]*\./g) ?? [];
  for (const sentence of mentions) {
    assert.match(sentence, /no longer available|does not call any Google service APIs|Google Meet or Zoom/i, sentence);
  }
});

// =============================================================== schema compatibility retained
test("the user_integrations table and its migrations are intentionally retained", async () => {
  assert.match(await read("supabase/migrations/20260708053000_add_user_integrations.sql"), /create table if not exists public\.user_integrations/);
  assert.match(await read("supabase/migrations/20260818231713_production_launch_alignment.sql"), /create table public\.user_integrations/);
});

test("removing the unused GOOGLE_* env declarations cannot break boot when they are still set in Vercel", async () => {
  const env = await read("lib/env.ts");
  assert.doesNotMatch(env, /GOOGLE_/);
  // The schema is a zod object, which strips unknown keys by default; confirm it is not .strict().
  assert.doesNotMatch(env, /coreEnvSchema[\s\S]{0,2000}\.strict\(\)/);
});
