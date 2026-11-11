import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { NextRequest } from "next/server";

/**
 * Forgot Password (Flow B), exercised through the real route handlers end to end:
 *   POST /api/auth/password-reset  -> supabase.auth.resetPasswordForEmail (PKCE)
 *   GET  /api/auth/callback        -> exchangeCodeForSession, recovery marker, /account/reset-password
 *   POST /api/auth/password-update -> supabase.auth.updateUser({ password })   (no nonce)
 * Only the network edge (fetch to Supabase Auth) is stubbed; cookies are carried between steps the
 * way a browser would carry them.
 */

const SUPABASE_URL = "https://stubproject.supabase.co";
const APP_URL = "https://app.parfait.test";
const STORAGE_KEY = "sb-stubproject-auth-token";

process.env.NEXT_PUBLIC_SUPABASE_ENV = "staging";
process.env.NEXT_PUBLIC_STAGING_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_STAGING_SUPABASE_ANON_KEY = "anon-test-key";
process.env.NEXT_PUBLIC_APP_URL = APP_URL;

type Recorded = { method: string; url: URL; body: Record<string, unknown> | null };

function fakeJwt(sub: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub, aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600 })}.signature`;
}

const USER = {
  id: "user-recovery-1",
  aud: "authenticated",
  role: "authenticated",
  email: "person@example.com",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  identities: [],
  created_at: "2026-01-01T00:00:00Z"
};

/** Stubs global fetch with a tiny Supabase Auth double and records every request. */
function stubSupabase(options: { tokenStatus?: number } = {}) {
  const requests: Recorded[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    requests.push({ method, url, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

    if (url.pathname === "/auth/v1/recover" && method === "POST") return json(200, {});
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return json(options.tokenStatus, { code: "flow_state_not_found", msg: "invalid flow state" });
      }
      return json(200, {
        access_token: fakeJwt(USER.id),
        refresh_token: "refresh-test",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: USER
      });
    }
    if (url.pathname === "/auth/v1/user" && method === "GET") return json(200, USER);
    if (url.pathname === "/auth/v1/user" && method === "PUT") return json(200, USER);
    return json(404, { msg: `unexpected ${method} ${url.pathname}` });
  }) as typeof fetch;
  return { requests, restore: () => (globalThis.fetch = original) };
}

/** Minimal browser cookie jar: applies Set-Cookie headers, renders a Cookie header. */
function cookieJar() {
  const jar = new Map<string, string>();
  return {
    absorb(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(";");
        const index = pair.indexOf("=");
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
        if (expired || value === "") jar.delete(name);
        else jar.set(name, decodeURIComponent(value));
      }
    },
    header() {
      return [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
    },
    names: () => [...jar.keys()],
    get: (name: string) => jar.get(name)
  };
}

const routes = async () => ({
  reset: await import("../app/api/auth/password-reset/route"),
  callback: await import("../app/api/auth/callback/route"),
  update: await import("../app/api/auth/password-update/route")
});

test("Forgot Password redirect uses the resolved Vercel Preview branch URL", async () => {
  const { reset } = await routes();
  const names = ["VERCEL_ENV", "VERCEL_BRANCH_URL", "NEXT_PUBLIC_VERCEL_BRANCH_URL"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const host of ["parfait-git-branch-a-team.vercel.app", "parfait-git-branch-b-team.vercel.app"]) {
      // Server-side variable only, with NEXT_PUBLIC_APP_URL still pointing elsewhere.
      process.env.VERCEL_ENV = "preview";
      process.env.VERCEL_BRANCH_URL = host;
      delete process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL;
      const supabase = stubSupabase();
      try {
        const response = await reset.POST(
          new NextRequest(`https://${host}/api/auth/password-reset`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "person@example.com" })
          })
        );
        assert.equal(response.status, 200);
        const recover = supabase.requests.find((r) => r.url.pathname === "/auth/v1/recover");
        assert.equal(
          recover?.url.searchParams.get("redirect_to"),
          `https://${host}/api/auth/callback?next=/account/reset-password`
        );
      } finally {
        supabase.restore();
      }
    }
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("Forgot Password -> recovery link -> reset page -> updateUser({ password }) works end to end", async () => {
  const { reset, callback, update } = await routes();
  const { authRedirectFor } = await import("../lib/supabase/middleware");
  const supabase = stubSupabase();
  const jar = cookieJar();
  try {
    // 1. Signed-out user submits the Forgot Password form.
    const resetResponse = await reset.POST(
      new NextRequest(`${APP_URL}/api/auth/password-reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "Person@Example.com " })
      })
    );
    jar.absorb(resetResponse);
    assert.equal(resetResponse.status, 200);
    assert.deepEqual(await resetResponse.json(), {
      message: "If an account exists for that email, a secure password reset link has been sent."
    });

    const recover = supabase.requests.find((r) => r.url.pathname === "/auth/v1/recover");
    assert.ok(recover, "resetPasswordForEmail must call Supabase /recover");
    assert.equal(recover.body?.email, "person@example.com");
    assert.equal(
      recover.url.searchParams.get("redirect_to"),
      `${APP_URL}/api/auth/callback?next=/account/reset-password`
    );
    // PKCE: the challenge goes to Supabase, the verifier stays in this browser's cookie.
    assert.equal(typeof recover.body?.code_challenge, "string");
    assert.ok(jar.names().includes(`${STORAGE_KEY}-code-verifier`));
    // Recovery never uses the signed-in reauthentication flow or magic links.
    assert.ok(!supabase.requests.some((r) => /\/(reauthenticate|otp|magiclink)$/.test(r.url.pathname)));

    // 2. User clicks the emailed link, which Supabase redirects to our callback with ?code=.
    const callbackResponse = await callback.GET(
      new NextRequest(`${APP_URL}/api/auth/callback?next=/account/reset-password&code=recovery-code`, {
        headers: { cookie: jar.header() }
      })
    );
    jar.absorb(callbackResponse);
    assert.equal(callbackResponse.status, 307);
    assert.equal(callbackResponse.headers.get("location"), `${APP_URL}/account/reset-password`);
    const marker = callbackResponse.headers.getSetCookie().find((c) => c.startsWith("parfait-password-recovery="));
    assert.ok(marker && /HttpOnly/i.test(marker) && /SameSite=lax/i.test(marker), "recovery marker cookie");
    assert.ok(jar.get(STORAGE_KEY) || jar.names().some((n) => n.startsWith(`${STORAGE_KEY}.`)), "session cookie persisted");

    // 3. Middleware lets the recovering (now authenticated) user reach the dedicated reset page,
    //    and that page renders the reset form rather than the dashboard.
    assert.equal(authRedirectFor({ pathname: "/account/reset-password", hasUser: true }), null);
    const page = await readFile(new URL("../app/account/reset-password/page.tsx", import.meta.url), "utf8");
    assert.match(page, /cookieStore\.get\(RECOVERY_COOKIE_NAME\)\?\.value !== "active"/);
    assert.match(page, /return <ResetPasswordForm \/>;/);
    const form = await readFile(new URL("../components/reset-password-form.tsx", import.meta.url), "utf8");
    assert.match(form, /fetch\("\/api\/auth\/password-update"/);
    assert.doesNotMatch(form, /reauthenticate|nonce/);

    // 4. The reset form submits the new password with the recovery session.
    supabase.requests.length = 0;
    const updateResponse = await update.POST(
      new NextRequest(`${APP_URL}/api/auth/password-update`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: jar.header() },
        body: JSON.stringify({ password: "brand-new-pass-1", confirmPassword: "brand-new-pass-1" })
      })
    );
    jar.absorb(updateResponse);
    assert.equal(updateResponse.status, 200);
    const put = supabase.requests.filter((r) => r.url.pathname === "/auth/v1/user" && r.method === "PUT");
    assert.equal(put.length, 1);
    assert.equal(put[0].body?.password, "brand-new-pass-1");
    assert.equal("nonce" in (put[0].body ?? {}), false, "recovery update must not send a nonce");
    // One-time marker is cleared after success.
    assert.equal(jar.get("parfait-password-recovery"), undefined);
  } finally {
    supabase.restore();
  }
});

test("password-update refuses without the recovery marker, even for a signed-in session", async () => {
  const { callback, update } = await routes();
  const supabase = stubSupabase();
  const jar = cookieJar();
  try {
    // A normal (non-recovery) sign-in, e.g. Google: real session cookie, no recovery marker.
    const signIn = await callback.GET(
      new NextRequest(`${APP_URL}/api/auth/callback?next=/dashboard&code=oauth-code`, {
        headers: { cookie: `${STORAGE_KEY}-code-verifier=${encodeURIComponent(JSON.stringify("verifier"))}` }
      })
    );
    jar.absorb(signIn);
    assert.ok(jar.names().some((n) => n.startsWith(STORAGE_KEY) && !n.endsWith("-code-verifier")), "signed in");
    assert.equal(jar.get("parfait-password-recovery"), undefined);

    const response = await update.POST(
      new NextRequest(`${APP_URL}/api/auth/password-update`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: jar.header() },
        body: JSON.stringify({ password: "brand-new-pass-1", confirmPassword: "brand-new-pass-1" })
      })
    );
    assert.equal(response.status, 401);
    assert.ok(!supabase.requests.some((r) => r.method === "PUT"));
  } finally {
    supabase.restore();
  }
});

test("Google OAuth and signup-confirmation callbacks are unchanged: no recovery marker, normal destination", async () => {
  const { callback } = await routes();
  for (const [next, destination] of [
    ["/dashboard", "/dashboard"],
    ["%2Fprojects%2Fabc", "/projects/abc"],
    ["/account", "/account"],
    [null, "/dashboard"]
  ] as const) {
    const supabase = stubSupabase();
    try {
      const query = next === null ? "code=oauth-code" : `next=${next}&code=oauth-code`;
      const response = await callback.GET(
        new NextRequest(`${APP_URL}/api/auth/callback?${query}`, {
          headers: { cookie: `${STORAGE_KEY}-code-verifier=${encodeURIComponent(JSON.stringify("verifier"))}` }
        })
      );
      assert.equal(response.status, 307);
      assert.equal(response.headers.get("location"), `${APP_URL}${destination}`);
      assert.ok(
        !response.headers.getSetCookie().some((c) => c.startsWith("parfait-password-recovery=")),
        `${destination} must not set the recovery marker`
      );
      assert.ok(supabase.requests.some((r) => r.url.searchParams.get("grant_type") === "pkce"));
    } finally {
      supabase.restore();
    }
  }
});

test("an expired or reused recovery link goes back to Forgot Password with an explanation", async () => {
  const { callback } = await routes();
  const supabase = stubSupabase({ tokenStatus: 403 });
  try {
    const response = await callback.GET(
      new NextRequest(`${APP_URL}/api/auth/callback?next=/account/reset-password&code=stale`, {
        headers: { cookie: `${STORAGE_KEY}-code-verifier=${encodeURIComponent(JSON.stringify("verifier"))}` }
      })
    );
    assert.equal(response.headers.get("location"), `${APP_URL}/forgot-password?error=invalid_or_expired`);
    assert.ok(!response.headers.getSetCookie().some((c) => c.startsWith("parfait-password-recovery=active")));
  } finally {
    supabase.restore();
  }
});

test("normal login, signup and Google Sign In calls are unchanged and unrelated to either password flow", async () => {
  const source = await readFile(new URL("../components/auth-form.tsx", import.meta.url), "utf8");
  assert.match(source, /supabase\.auth\.signInWithPassword\(\{ email, password \}\)/);
  assert.match(source, /emailRedirectTo: `\$\{window\.location\.origin\}\/api\/auth\/callback\?next=\/account`/);
  assert.match(source, /signInWithOAuth\(\{\s*provider: "google",/);
  assert.match(source, /href="\/forgot-password"/);
  assert.doesNotMatch(source, /reauthenticate|resetPasswordForEmail|updateUser/);
});
