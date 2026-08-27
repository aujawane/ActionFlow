import assert from "node:assert/strict";
import test from "node:test";

import {
  PASSWORD_RESET_RESPONSE_MESSAGE,
  buildPasswordResetCallbackUrl,
  completeAuthCallback,
  initiatePasswordReset,
  recoveryErrorMessage,
  recoveryErrorPath,
  recoveryFailureReason,
  sanitizeInternalPath,
  updateRecoveryPassword,
  validateNewPassword
} from "../lib/password-recovery";
import { authRedirectFor } from "../lib/supabase/middleware";

test("successful reset request uses the account reset callback and stays enumeration-safe", async () => {
  let sent: { email: string; redirectTo: string } | null = null;
  const redirectTo = buildPasswordResetCallbackUrl("https://parfait.example/");
  const result = await initiatePasswordReset({
    email: "person@example.com",
    redirectTo,
    resetPasswordForEmail: async (email, options) => {
      sent = { email, redirectTo: options.redirectTo };
      return { error: null };
    }
  });

  assert.deepEqual(sent, {
    email: "person@example.com",
    redirectTo: "https://parfait.example/api/auth/callback?next=/account/reset-password"
  });
  assert.equal(result.message, PASSWORD_RESET_RESPONSE_MESSAGE);
  assert.equal(result.error, null);
});

test("PKCE callback exchanges its code and confirms the persisted recovery session", async () => {
  let exchanged = false;
  const result = await completeAuthCallback({
    code: "secret-code-not-logged",
    tokenHash: null,
    type: null,
    providerError: null,
    auth: {
      exchangeCodeForSession: async () => {
        exchanged = true;
        return { error: null };
      },
      verifyOtp: async () => ({ error: new Error("unexpected") }),
      getUser: async () => ({ data: { user: exchanged ? { id: "user-1" } : null }, error: null })
    }
  });

  assert.equal(exchanged, true);
  assert.equal(result.sessionEstablished, true);
  assert.equal(result.credentialKind, "code");
});

test("token-hash recovery callback verifies the supported recovery OTP", async () => {
  let verified = false;
  const result = await completeAuthCallback({
    code: null,
    tokenHash: "secret-token-hash-not-logged",
    type: "recovery",
    providerError: null,
    auth: {
      exchangeCodeForSession: async () => ({ error: new Error("unexpected") }),
      verifyOtp: async () => {
        verified = true;
        return { error: null };
      },
      getUser: async () => ({ data: { user: verified ? { id: "user-1" } : null }, error: null })
    }
  });

  assert.equal(result.sessionEstablished, true);
  assert.equal(result.credentialKind, "token_hash");
});

test("callback rejects missing, invalid, expired, and unsafe recovery inputs", async () => {
  const missing = await completeAuthCallback({
    code: null,
    tokenHash: null,
    type: null,
    providerError: null,
    auth: {
      exchangeCodeForSession: async () => ({ error: null }),
      verifyOtp: async () => ({ error: null }),
      getUser: async () => ({ data: { user: null }, error: null })
    }
  });
  assert.equal(missing.sessionEstablished, false);
  assert.equal(missing.error?.name, "MissingRecoveryCredentials");

  const expired = await completeAuthCallback({
    code: "expired-code",
    tokenHash: null,
    type: null,
    providerError: null,
    auth: {
      exchangeCodeForSession: async () => ({
        error: { name: "AuthApiError", message: "Code has expired" }
      }),
      verifyOtp: async () => ({ error: null }),
      getUser: async () => ({ data: { user: null }, error: null })
    }
  });
  assert.equal(expired.sessionEstablished, false);
  assert.match(expired.error?.message ?? "", /expired/i);
  assert.equal(sanitizeInternalPath("https://evil.example/steal"), "/dashboard");
  assert.equal(sanitizeInternalPath("//evil.example/steal"), "/dashboard");
  assert.equal(sanitizeInternalPath("/account/reset-password"), "/account/reset-password");
});

test("recovery failure reason distinguishes a missing PKCE verifier cookie from an expired/invalid code", () => {
  assert.equal(
    recoveryFailureReason({
      credentialKind: "code",
      providerError: null,
      errorName: "AuthPKCECodeVerifierMissingError"
    }),
    "verifier_missing"
  );
  assert.equal(
    recoveryFailureReason({
      credentialKind: "code",
      providerError: null,
      errorName: "AuthApiError"
    }),
    "invalid_or_expired"
  );
  assert.equal(
    recoveryFailureReason({
      credentialKind: "missing",
      providerError: null,
      errorName: undefined
    }),
    "missing_credentials"
  );
  assert.equal(
    recoveryFailureReason({
      credentialKind: "missing",
      providerError: "access_denied",
      errorName: undefined
    }),
    "invalid_or_expired"
  );
});

test("verifier_missing reason round-trips through the error path and gets an actionable message", () => {
  assert.equal(recoveryErrorPath("verifier_missing"), "/forgot-password?error=verifier_missing");
  assert.match(recoveryErrorMessage("verifier_missing") ?? "", /same browser/i);
});

test("middleware admits a persisted recovery session and blocks an unauthenticated reset page", () => {
  assert.equal(authRedirectFor({ pathname: "/account/reset-password", hasUser: true }), null);
  assert.equal(
    authRedirectFor({ pathname: "/account/reset-password", hasUser: false }),
    "/forgot-password?error=recovery_session_required"
  );
  assert.equal(authRedirectFor({ pathname: "/account", hasUser: false }), "/login");
  assert.equal(authRedirectFor({ pathname: "/api/auth/callback", hasUser: false }), null);
});

test("password validation rejects mismatches before any update", () => {
  assert.equal(
    validateNewPassword({ password: "strong-password", confirmPassword: "different-password" }),
    "Passwords do not match."
  );
});

test("valid recovery session updates the password exactly once", async () => {
  let updates = 0;
  const result = await updateRecoveryPassword({
    password: "new-password-123",
    confirmPassword: "new-password-123",
    hasRecoveryMarker: true,
    getUser: async () => ({ user: { id: "user-1" }, error: null }),
    updateUser: async () => {
      updates += 1;
      return { error: null };
    }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(updates, 1);
});

test("failed password update returns a clear error and expired marker prevents updates", async () => {
  const failed = await updateRecoveryPassword({
    password: "new-password-123",
    confirmPassword: "new-password-123",
    hasRecoveryMarker: true,
    getUser: async () => ({ user: { id: "user-1" }, error: null }),
    updateUser: async () => ({ error: { message: "Password rejected" } })
  });
  assert.deepEqual(failed, { ok: false, status: 400, error: "Password rejected" });

  let updated = false;
  const expired = await updateRecoveryPassword({
    password: "new-password-123",
    confirmPassword: "new-password-123",
    hasRecoveryMarker: false,
    getUser: async () => ({ user: { id: "user-1" }, error: null }),
    updateUser: async () => {
      updated = true;
      return { error: null };
    }
  });
  assert.equal(expired.ok, false);
  assert.equal(updated, false);
});
