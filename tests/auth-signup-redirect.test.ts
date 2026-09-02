import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sanitizeInternalPath } from "../lib/password-recovery";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// [1] Signup uses /api/auth/callback?next=/account
// ---------------------------------------------------------------------------

test("email/password signup redirects verification to /api/auth/callback?next=/account", async () => {
  const source = await readSource("components/auth-form.tsx");
  const signUpCall = source.match(/supabase\.auth\.signUp\(\{[\s\S]*?\n {10}\}\)/);
  assert.ok(signUpCall, "expected a supabase.auth.signUp(...) call");
  assert.match(
    signUpCall![0],
    /emailRedirectTo: `\$\{window\.location\.origin\}\/api\/auth\/callback\?next=\/account`/
  );
});

// ---------------------------------------------------------------------------
// [2] Password recovery still uses /api/auth/callback?next=/account/reset-password
// ---------------------------------------------------------------------------

test("password recovery is untouched: it still builds /api/auth/callback?next=/account/reset-password", async () => {
  const source = await readSource("lib/password-recovery.ts");
  assert.match(
    source,
    /return `\$\{publicOrigin\.replace\(\/\\\/\$\/, ""\)\}\/api\/auth\/callback\?next=\/account\/reset-password`;/
  );
});

test("login and OAuth continue to fall back to /dashboard, unaffected by the signup change", async () => {
  const source = await readSource("components/auth-form.tsx");
  assert.match(source, /sanitizeInternalPath\(searchParams\.get\("next"\), "\/dashboard"\)/);
  // Only the signup branch's emailRedirectTo changed; signInWithPassword takes no redirect option.
  assert.match(source, /supabase\.auth\.signInWithPassword\(\{ email, password \}\)/);
});

// ---------------------------------------------------------------------------
// [3] The auth callback allows /account as a safe internal destination
// ---------------------------------------------------------------------------

test("sanitizeInternalPath treats /account as a safe internal destination, not a fallback substitution", () => {
  assert.equal(sanitizeInternalPath("/account", "/dashboard"), "/account");
});

// ---------------------------------------------------------------------------
// [4] Normal signup verification cannot route to reset-password unless explicitly given that next
// ---------------------------------------------------------------------------

test("the callback route only treats next=/account/reset-password as the recovery destination -- /account never sets the recovery cookie", async () => {
  const source = await readSource("app/api/auth/callback/route.ts");
  assert.match(source, /const isRecoveryDestination = next === "\/account\/reset-password";/);
});

test("signup's own next value (/account) is not the recovery path, so the recovery cookie path is not triggered", () => {
  const next = sanitizeInternalPath("/account", "/dashboard");
  assert.notEqual(next, "/account/reset-password");
});

// ---------------------------------------------------------------------------
// [5] No localhost URL is hardcoded into signup
// ---------------------------------------------------------------------------

test("signup derives its origin from window.location.origin -- no hardcoded localhost or production domain", async () => {
  const source = await readSource("components/auth-form.tsx");
  assert.doesNotMatch(source, /localhost/i);
  assert.doesNotMatch(source, /https?:\/\/[a-z0-9.-]+\.(com|app|dev|io)/i);
  const signUpCall = source.match(/supabase\.auth\.signUp\(\{[\s\S]*?\n {10}\}\)/);
  assert.match(signUpCall![0], /\$\{window\.location\.origin\}/);
});
