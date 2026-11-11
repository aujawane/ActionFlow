import "./support/react-global";

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChangePasswordDialog } from "../components/change-password-dialog";
import {
  PASSWORD_CHANGED_NOTICE,
  PASSWORD_CHANGE_RESEND_COOLDOWN_SECONDS,
  createPasswordChangeController,
  describeUpdatePasswordError,
  hasPasswordCredential,
  type AuthLikeError,
  type PasswordChangeEvent
} from "../lib/password-change";

const EMAIL = "person@example.com";
const GOOD = "correct-horse-battery";
const REAUTH_NEEDED: AuthLikeError = {
  name: "AuthApiError",
  code: "reauthentication_needed",
  status: 400,
  message: "Password update requires reauthentication"
};

type UpdateAttrs = { password: string; nonce?: string };
type Result = { error: AuthLikeError | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Fake supabase.auth that records every call. Recovery/OTP primitives throw if touched. */
function fakeAuth(options: {
  reauthenticate?: () => Promise<Result>;
  updateUser?: (attrs: UpdateAttrs) => Promise<Result>;
}) {
  const calls = { reauthenticate: 0, updateUser: [] as UpdateAttrs[], forbidden: [] as string[] };
  const auth = {
    reauthenticate: async () => {
      calls.reauthenticate += 1;
      return options.reauthenticate ? options.reauthenticate() : { error: null };
    },
    updateUser: async (attrs: UpdateAttrs) => {
      calls.updateUser.push({ ...attrs });
      return options.updateUser ? options.updateUser(attrs) : { error: null };
    }
  };
  for (const name of ["resetPasswordForEmail", "signInWithOtp", "verifyOtp", "signInWithPassword"]) {
    Object.defineProperty(auth, name, {
      value: () => {
        calls.forbidden.push(name);
        throw new Error(`${name} must not be called by Change Password`);
      }
    });
  }
  return { auth, calls };
}

/** Session created within 24h (or Secure password change off): Supabase accepts the change. */
const freshSession = { updateUser: async (): Promise<Result> => ({ error: null }) };

/** Session older than 24h with Secure password change on: a nonce is mandatory. */
function staleSession(verify: (nonce: string) => Result = () => ({ error: null })) {
  return {
    updateUser: async (attrs: UpdateAttrs): Promise<Result> =>
      attrs.nonce === undefined ? { error: REAUTH_NEEDED } : verify(attrs.nonce)
  };
}

function setup(options: Parameters<typeof fakeAuth>[0]) {
  const { auth, calls } = fakeAuth(options);
  const events: PasswordChangeEvent[] = [];
  const clock = { t: 1_000_000 };
  const controller = createPasswordChangeController({
    auth,
    email: EMAIL,
    onEvent: (event) => events.push(event),
    now: () => clock.t
  });
  controller.setField("newPassword", GOOD);
  controller.setField("confirmPassword", GOOD);
  return { controller, calls, events, clock };
}

/** Stale session, after the first attempt has moved the user to the code step. */
async function reachCodeStep(options: Parameters<typeof fakeAuth>[0] = staleSession()) {
  const ctx = setup(options);
  assert.equal(await ctx.controller.submitPassword(), false);
  assert.equal(ctx.controller.getState().step, "enter-code");
  return ctx;
}

function render(controller: ReturnType<typeof createPasswordChangeController>) {
  return renderToStaticMarkup(
    createElement(ChangePasswordDialog, { email: EMAIL, onClose: () => {}, controller })
  );
}

// ---------------------------------------------------------------------------------------------
// 1. Fresh session: one updateUser({ password }), no code ever sent or shown
// ---------------------------------------------------------------------------------------------

test("fresh session: updateUser({ password }) succeeds, reauthenticate is not called, no code step", async () => {
  const ctx = setup(freshSession);
  const before = render(ctx.controller);
  assert.match(before, /Change password<\/button>/);
  assert.doesNotMatch(before, /id="verification-code"/);

  assert.equal(await ctx.controller.submitPassword(), true);

  assert.deepEqual(ctx.calls.updateUser, [{ password: GOOD }]);
  assert.equal("nonce" in ctx.calls.updateUser[0], false);
  assert.equal(ctx.calls.reauthenticate, 0);
  assert.deepEqual(ctx.calls.forbidden, []);

  const state = ctx.controller.getState();
  assert.equal(state.step, "done");
  assert.equal(state.notice, PASSWORD_CHANGED_NOTICE);
  assert.equal(state.newPassword + state.confirmPassword + state.verificationCode, "");
  assert.deepEqual(ctx.events, [{ type: "password_change_verified", method: "recent_session" }]);

  const after = render(ctx.controller);
  assert.match(after, /Your password has been changed/);
  assert.doesNotMatch(after, /id="verification-code"|id="new-password"/);
  assert.doesNotMatch(after, new RegExp(GOOD));
});

// ---------------------------------------------------------------------------------------------
// 2. Stale session: reauthentication_needed -> reauthenticate() -> code step -> { password, nonce }
// ---------------------------------------------------------------------------------------------

test("stale session: reauthentication_needed triggers reauthenticate(), the code step, then { password, nonce }", async () => {
  const ctx = setup(staleSession());
  assert.equal(await ctx.controller.submitPassword(), false);

  assert.deepEqual(ctx.calls.updateUser, [{ password: GOOD }]);
  assert.equal(ctx.calls.reauthenticate, 1);
  const codeStep = ctx.controller.getState();
  assert.equal(codeStep.step, "enter-code");
  assert.equal(codeStep.error, null);
  assert.match(codeStep.notice ?? "", /we sent a verification code to person@example\.com/);
  // Supabase asking for reauthentication is not a failure.
  assert.deepEqual(ctx.events, [{ type: "password_code_requested" }]);

  const html = render(ctx.controller);
  assert.match(html, /id="verification-code"/);
  assert.match(html, /autocomplete="one-time-code"/i);
  // Passwords typed in step 1 are kept, so the user doesn't retype them.
  assert.match(html, /id="new-password"/);
  assert.equal(codeStep.newPassword, GOOD);

  ctx.controller.setField("verificationCode", " 123 456 ");
  assert.equal(await ctx.controller.submitCode(), true);
  assert.deepEqual(ctx.calls.updateUser, [{ password: GOOD }, { password: GOOD, nonce: "123456" }]);
  assert.equal(ctx.calls.reauthenticate, 1);
  assert.equal(ctx.controller.getState().step, "done");
  assert.equal(ctx.controller.getState().verificationCode, "");
  assert.deepEqual(ctx.events.at(-1), { type: "password_change_verified", method: "reauthentication_code" });
  assert.deepEqual(ctx.calls.forbidden, []);
});

// ---------------------------------------------------------------------------------------------
// 3. Invalid / expired nonce
// ---------------------------------------------------------------------------------------------

test("invalid nonce (reauthentication_not_valid) is surfaced; code cleared, passwords kept, still on code step", async () => {
  const ctx = await reachCodeStep(
    staleSession(() => ({
      error: { name: "AuthApiError", code: "reauthentication_not_valid", status: 422, message: "Reauthentication failed" }
    }))
  );
  ctx.controller.setField("verificationCode", "000000");
  assert.equal(await ctx.controller.submitCode(), false);

  const state = ctx.controller.getState();
  assert.equal(state.step, "enter-code");
  assert.equal(
    state.error,
    "That verification code is invalid or has expired. Check the latest email, or request a new code."
  );
  assert.equal(state.verificationCode, "");
  assert.equal(state.newPassword, GOOD);
  assert.deepEqual(ctx.events.at(-1), { type: "password_change_failed", reason: "reauthentication_not_valid" });
  assert.match(render(ctx.controller), /role="alert"/);
});

test("expired nonce gets the expired-code message", async () => {
  const ctx = await reachCodeStep(
    staleSession(() => ({ error: { code: "reauthentication_not_valid", status: 422, message: "Verification code has expired" } }))
  );
  ctx.controller.setField("verificationCode", "123456");
  await ctx.controller.submitCode();
  assert.equal(ctx.controller.getState().error, "That verification code has expired. Request a new code and try again.");
});

// ---------------------------------------------------------------------------------------------
// 4. Resend
// ---------------------------------------------------------------------------------------------

test("Resend code respects the cooldown, calls reauthenticate() again, and clears the stale code", async () => {
  const ctx = await reachCodeStep();
  assert.equal(ctx.controller.secondsUntilResend(), PASSWORD_CHANGE_RESEND_COOLDOWN_SECONDS);
  assert.match(render(ctx.controller), new RegExp(`Resend code in ${PASSWORD_CHANGE_RESEND_COOLDOWN_SECONDS}s`));

  assert.equal(await ctx.controller.resendCode(), false);
  assert.equal(ctx.calls.reauthenticate, 1);

  ctx.clock.t += PASSWORD_CHANGE_RESEND_COOLDOWN_SECONDS * 1000;
  ctx.controller.setField("verificationCode", "111111");
  assert.equal(await ctx.controller.resendCode(), true);
  assert.equal(ctx.calls.reauthenticate, 2);
  const state = ctx.controller.getState();
  assert.equal(state.step, "enter-code");
  assert.equal(state.verificationCode, "");
  assert.equal(state.notice, `We sent a new verification code to ${EMAIL}.`);
  assert.equal(state.newPassword, GOOD);
  // Resending never re-attempts the password change on its own.
  assert.equal(ctx.calls.updateUser.length, 1);
});

test("a rate-limited resend keeps the user on the code step with an error and a fresh cooldown", async () => {
  let call = 0;
  const ctx = await reachCodeStep({
    ...staleSession(),
    reauthenticate: async () =>
      ++call === 1 ? { error: null } : { error: { code: "over_email_send_rate_limit", status: 429 } }
  });
  ctx.clock.t += PASSWORD_CHANGE_RESEND_COOLDOWN_SECONDS * 1000;
  assert.equal(await ctx.controller.resendCode(), false);
  assert.equal(ctx.controller.getState().step, "enter-code");
  assert.match(ctx.controller.getState().error ?? "", /Too many verification emails/);
  assert.equal(ctx.controller.secondsUntilResend(), PASSWORD_CHANGE_RESEND_COOLDOWN_SECONDS);
});

// ---------------------------------------------------------------------------------------------
// 5. A code is never presented unless Supabase demanded reauthentication
// ---------------------------------------------------------------------------------------------

test("only reauthentication_needed leads to a code; every other first-attempt error stays on step 1", async () => {
  const others: AuthLikeError[] = [
    { code: "weak_password", status: 422, name: "AuthWeakPasswordError" },
    { code: "same_password", status: 422 },
    { code: "reauth_nonce_missing", status: 400 },
    { code: "reauthentication_not_valid", status: 422 },
    { code: "over_request_rate_limit", status: 429 },
    { name: "AuthSessionMissingError", status: 400 },
    { name: "AuthApiError", status: 500, message: "boom" }
  ];
  for (const error of others) {
    const ctx = setup({ updateUser: async () => ({ error }) });
    assert.equal(await ctx.controller.submitPassword(), false);
    assert.equal(ctx.calls.reauthenticate, 0, JSON.stringify(error));
    const state = ctx.controller.getState();
    assert.equal(state.step, "enter-password", JSON.stringify(error));
    assert.ok(state.error, JSON.stringify(error));
    assert.doesNotMatch(render(ctx.controller), /id="verification-code"/);
  }

  // A thrown network failure also never escalates to a code.
  const offline = setup({
    updateUser: async () => {
      throw new TypeError("Failed to fetch");
    }
  });
  await offline.controller.submitPassword();
  assert.equal(offline.calls.reauthenticate, 0);
  assert.match(offline.controller.getState().error ?? "", /couldn't reach the server/);
});

test("nothing claims a code was verified: no code wording on the fresh path, success copy is code-neutral", async () => {
  const fresh = setup(freshSession);
  const seen: string[] = [render(fresh.controller)];
  fresh.controller.subscribe(() => seen.push(render(fresh.controller)));
  await fresh.controller.submitPassword();
  for (const html of seen.slice(1)) {
    assert.doesNotMatch(html, /verification code|verified|id="verification-code"/i);
  }
  // Step 1 copy describes the code as conditional, not as something that will happen.
  assert.match(seen[0], /If you haven&#x27;t signed in recently/);
  assert.doesNotMatch(seen[0], /we&#x27;ll email a verification code|Send verification code/);
  assert.doesNotMatch(PASSWORD_CHANGED_NOTICE, /verif|code/i);

  const stale = await reachCodeStep();
  stale.controller.setField("verificationCode", "123456");
  await stale.controller.submitCode();
  assert.equal(stale.controller.getState().notice, PASSWORD_CHANGED_NOTICE);
});

// ---------------------------------------------------------------------------------------------
// Local validation
// ---------------------------------------------------------------------------------------------

test("password mismatch blocks the first attempt and the code submit", async () => {
  const ctx = setup(freshSession);
  ctx.controller.setField("confirmPassword", "something-else-1");
  assert.equal(await ctx.controller.submitPassword(), false);
  assert.deepEqual(ctx.calls.updateUser, []);
  assert.equal(ctx.controller.getState().error, "Passwords do not match.");

  const later = await reachCodeStep();
  later.controller.setField("confirmPassword", "changed-my-mind-1");
  later.controller.setField("verificationCode", "123456");
  assert.equal(await later.controller.submitCode(), false);
  assert.equal(later.calls.updateUser.length, 1);
  assert.equal(later.controller.getState().error, "Passwords do not match.");
});

test("too-short / too-long passwords are rejected locally; Supabase weak_password is explained", async () => {
  const ctx = setup(freshSession);
  ctx.controller.setField("newPassword", "short");
  ctx.controller.setField("confirmPassword", "short");
  await ctx.controller.submitPassword();
  assert.equal(ctx.controller.getState().error, "Password must be at least 8 characters.");

  const long = "x".repeat(257);
  ctx.controller.setField("newPassword", long);
  ctx.controller.setField("confirmPassword", long);
  await ctx.controller.submitPassword();
  assert.equal(ctx.controller.getState().error, "Password is too long.");
  assert.deepEqual(ctx.calls.updateUser, []);

  const weak = setup({
    updateUser: async () => ({ error: { name: "AuthWeakPasswordError", code: "weak_password", status: 422 } })
  });
  await weak.controller.submitPassword();
  assert.match(weak.controller.getState().error ?? "", /too weak/);
});

test("an empty verification code is rejected before calling updateUser", async () => {
  const ctx = await reachCodeStep();
  ctx.controller.setField("verificationCode", "   ");
  assert.equal(await ctx.controller.submitCode(), false);
  assert.equal(ctx.calls.updateUser.length, 1);
  assert.equal(ctx.controller.getState().error, "Enter the verification code from your email.");
});

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

test("Supabase update errors map to specific, non-technical messages", () => {
  const cases: Array<[AuthLikeError, RegExp]> = [
    [{ code: "reauthentication_not_valid", message: "Requires reauthentication" }, /invalid or has expired/],
    [{ code: "otp_expired" }, /has expired\. Request a new code/],
    [{ code: "reauthentication_needed" }, /request a new verification code/i],
    [{ code: "same_password" }, /different from your current password/],
    [{ code: "over_request_rate_limit", status: 429 }, /Too many attempts/],
    [{ name: "AuthSessionMissingError" }, /Sign in again/],
    [{ name: "AuthRetryableFetchError", status: 0 }, /couldn't reach the server/],
    [{ name: "AuthApiError", status: 500, message: "internal: db timeout" }, /couldn't change your password/]
  ];
  for (const [error, expected] of cases) {
    const message = describeUpdatePasswordError(error);
    assert.match(message, expected, JSON.stringify(error));
    assert.doesNotMatch(message, /internal|db timeout|AuthApiError/);
  }
});

test("reauthenticate() failures after reauthentication_needed are surfaced; user stays on step 1", async () => {
  const failing = setup({ ...staleSession(), reauthenticate: async () => ({ error: { name: "AuthApiError", status: 500 } }) });
  assert.equal(await failing.controller.submitPassword(), false);
  assert.equal(failing.controller.getState().step, "enter-password");
  assert.equal(failing.controller.getState().error, "We couldn't send a verification code right now. Please try again.");
  assert.equal(failing.controller.getState().pending, null);
  assert.deepEqual(failing.events, []);
  assert.equal(failing.controller.getState().newPassword, GOOD);

  const limited = setup({ ...staleSession(), reauthenticate: async () => ({ error: { code: "over_email_send_rate_limit", status: 429 } }) });
  await limited.controller.submitPassword();
  assert.match(limited.controller.getState().error ?? "", /Too many verification emails/);

  const offline = setup({
    ...staleSession(),
    reauthenticate: async () => {
      throw new TypeError("Failed to fetch");
    }
  });
  await offline.controller.submitPassword();
  assert.match(offline.controller.getState().error ?? "", /couldn't reach the server/);
});

test("network failure on the code submit keeps the typed code (it says nothing about the code)", async () => {
  const ctx = await reachCodeStep(staleSession(() => {
    throw new TypeError("Failed to fetch");
  }));
  ctx.controller.setField("verificationCode", "123456");
  assert.equal(await ctx.controller.submitCode(), false);
  const state = ctx.controller.getState();
  assert.match(state.error ?? "", /couldn't reach the server/);
  assert.equal(state.pending, null);
  assert.equal(state.verificationCode, "123456");
});

// ---------------------------------------------------------------------------------------------
// Duplicate submissions and sensitive state
// ---------------------------------------------------------------------------------------------

test("double-clicking Change password sends one updateUser (fresh session)", async () => {
  const gate = deferred<Result>();
  const ctx = setup({ updateUser: () => gate.promise });
  const first = ctx.controller.submitPassword();
  const second = ctx.controller.submitPassword();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.calls.updateUser.length, 1);
  assert.match(render(ctx.controller), /Changing password\.\.\./);
  gate.resolve({ error: null });
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(ctx.calls.updateUser.length, 1);
});

test("clicking again while the code is being requested sends one updateUser and one reauthenticate", async () => {
  const gate = deferred<Result>();
  const ctx = setup({ ...staleSession(), reauthenticate: () => gate.promise });
  const first = ctx.controller.submitPassword();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.controller.getState().pending, "send");
  assert.match(render(ctx.controller), /Sending verification code\.\.\./);
  assert.equal(await ctx.controller.submitPassword(), false);
  gate.resolve({ error: null });
  await first;
  assert.equal(ctx.calls.updateUser.length, 1);
  assert.equal(ctx.calls.reauthenticate, 1);
});

test("double-clicking the code submit sends one updateUser({ password, nonce })", async () => {
  const gate = deferred<Result>();
  const ctx = await reachCodeStep({
    updateUser: (attrs) => (attrs.nonce === undefined ? Promise.resolve({ error: REAUTH_NEEDED }) : gate.promise)
  });
  ctx.controller.setField("verificationCode", "123456");
  const first = ctx.controller.submitCode();
  const second = ctx.controller.submitCode();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.calls.updateUser.filter((c) => c.nonce).length, 1);
  gate.resolve({ error: null });
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(ctx.calls.updateUser.filter((c) => c.nonce).length, 1);
});

test("after success, typing and resubmitting do nothing; closing (reset) wipes everything", async () => {
  const ctx = setup(freshSession);
  await ctx.controller.submitPassword();
  ctx.controller.setField("newPassword", "typed-after-success");
  assert.equal(ctx.controller.getState().newPassword, "");
  assert.equal(await ctx.controller.submitPassword(), false);
  assert.equal(await ctx.controller.submitCode(), false);
  assert.equal(ctx.calls.updateUser.length, 1);

  const open = await reachCodeStep();
  open.controller.setField("verificationCode", "123456");
  open.controller.reset();
  const state = open.controller.getState();
  assert.equal(state.step, "enter-password");
  assert.equal(state.newPassword + state.confirmPassword + state.verificationCode, "");
});

test("development diagnostics never include the password or the verification code", async () => {
  const previous = process.env.NODE_ENV;
  const logged: string[] = [];
  const original = { info: console.info, log: console.log, error: console.error, warn: console.warn };
  const capture = (...args: unknown[]) => logged.push(JSON.stringify(args));
  Object.assign(console, { info: capture, log: capture, error: capture, warn: capture });
  (process.env as Record<string, string>).NODE_ENV = "development";
  try {
    const ctx = await reachCodeStep(
      staleSession(() => ({ error: { code: "reauthentication_not_valid", status: 422, message: "Reauthentication failed" } }))
    );
    ctx.controller.setField("verificationCode", "987654");
    await ctx.controller.submitCode();
  } finally {
    Object.assign(console, original);
    (process.env as Record<string, string | undefined>).NODE_ENV = previous;
  }
  assert.ok(logged.length > 0, "expected a development diagnostic");
  const all = logged.join("\n");
  assert.ok(all.includes("reauthentication_not_valid"));
  assert.ok(!all.includes(GOOD) && !all.includes("987654"));
});

// ---------------------------------------------------------------------------------------------
// Wrong primitives, removed route, Google-only gating
// ---------------------------------------------------------------------------------------------

test("signed-in flow sources never call resetPasswordForEmail, signInWithOtp, verifyOtp or service-role APIs", async () => {
  for (const file of ["lib/password-change.ts", "components/change-password-dialog.tsx", "components/account-settings-client.tsx"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const banned of ["resetPasswordForEmail", "signInWithOtp", "verifyOtp", "supabaseAdmin", "auth.admin", "updateUserById", "/api/account/password-code"]) {
      assert.ok(!code.includes(banned), `${file} must not reference ${banned}`);
    }
  }
  assert.equal(existsSync(new URL("../app/api/account/password-code/route.ts", import.meta.url)), false);
});

test("hasPasswordCredential: email accounts yes, Google-only accounts no, linked accounts yes", () => {
  assert.equal(hasPasswordCredential({ email: EMAIL, app_metadata: { provider: "email", providers: ["email"] } }), true);
  assert.equal(hasPasswordCredential({ email: EMAIL, app_metadata: { provider: "google", providers: ["google"] } }), false);
  assert.equal(hasPasswordCredential({ email: EMAIL, app_metadata: { provider: "email", providers: ["email", "google"] } }), true);
  assert.equal(hasPasswordCredential({ email: EMAIL, app_metadata: {}, identities: [{ provider: "google" }] }), false);
  assert.equal(hasPasswordCredential({ email: EMAIL, app_metadata: {}, identities: [{ provider: "email" }] }), true);
  assert.equal(hasPasswordCredential({ email: null, app_metadata: { providers: ["email"] } }), false);
});

test("Change Password is hidden for Google-only accounts in settings and the account menu", async () => {
  const settings = await readFile(new URL("../components/account-settings-client.tsx", import.meta.url), "utf8");
  assert.match(settings, /canChangePassword \? \(/);
  assert.match(settings, /You sign in with Google, so there is no Parfait password on this account/);
  assert.match(settings, /canChangePassword && searchParams\.get\("changePassword"\) === "1"/);
  assert.match(settings, /passwordModalOpen && canChangePassword \?/);

  const menu = await readFile(new URL("../components/account-menu.tsx", import.meta.url), "utf8");
  assert.match(menu, /\{canChangePassword \? \(\s*<Link\s+href="\/account\?changePassword=1"/);

  for (const file of ["../app/account/page.tsx", "../components/account-menu-server.tsx"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /canChangePassword=\{hasPasswordCredential\(user\)\}/, file);
  }
});
