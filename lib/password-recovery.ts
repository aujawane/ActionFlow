export const RECOVERY_COOKIE_NAME = "parfait-password-recovery";
export const RECOVERY_COOKIE_MAX_AGE_SECONDS = 15 * 60;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_RESET_RESPONSE_MESSAGE =
  "If an account exists for that email, a secure password reset link has been sent.";

export function buildPasswordResetCallbackUrl(publicOrigin: string) {
  return `${publicOrigin.replace(/\/$/, "")}/api/auth/callback?next=/account/reset-password`;
}

export async function initiatePasswordReset(input: {
  email: string;
  redirectTo: string;
  resetPasswordForEmail: (
    email: string,
    options: { redirectTo: string }
  ) => Promise<{ error: { name?: string; message?: string } | null }>;
}) {
  const { error } = await input.resetPasswordForEmail(input.email, {
    redirectTo: input.redirectTo
  });
  return { error, message: PASSWORD_RESET_RESPONSE_MESSAGE };
}

export function sanitizeInternalPath(
  value: string | null | undefined,
  fallback = "/dashboard"
) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  if (value.includes("\\") || /[\u0000-\u001f]/.test(value)) return fallback;
  try {
    const parsed = new URL(value, "https://parfait.invalid");
    if (parsed.origin !== "https://parfait.invalid") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function recoveryErrorPath(reason: string) {
  const safeReason = [
    "missing_credentials",
    "invalid_or_expired",
    "recovery_session_required"
  ].includes(reason)
    ? reason
    : "invalid_or_expired";
  return `/forgot-password?error=${safeReason}`;
}

export function recoveryErrorMessage(error: string | undefined) {
  if (error === "missing_credentials") {
    return "This reset link is incomplete. Request a new password-reset email.";
  }
  if (error === "invalid_or_expired") {
    return "This reset link is invalid, expired, or has already been used. Request a new one.";
  }
  if (error === "recovery_session_required") {
    return "Your password-reset session is no longer valid. Request a new reset link.";
  }
  return null;
}

export function validateNewPassword(input: {
  password: unknown;
  confirmPassword: unknown;
}): string | null {
  if (typeof input.password !== "string" || input.password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (input.password.length > 256) return "Password is too long.";
  if (input.password !== input.confirmPassword) return "Passwords do not match.";
  return null;
}

type AuthResult = { error: { name?: string; message?: string } | null };

export type RecoveryAuthClient = {
  exchangeCodeForSession(code: string): Promise<AuthResult>;
  verifyOtp(input: { token_hash: string; type: "recovery" }): Promise<AuthResult>;
  getUser(): Promise<{
    data: { user: unknown | null };
    error: { name?: string; message?: string } | null;
  }>;
};

export async function completeAuthCallback(input: {
  code: string | null;
  tokenHash: string | null;
  type: string | null;
  providerError: string | null;
  auth: RecoveryAuthClient;
}) {
  let credentialKind: "code" | "token_hash" | "missing" = "missing";
  let error: { name?: string; message?: string } | null = null;
  if (input.code) {
    credentialKind = "code";
    ({ error } = await input.auth.exchangeCodeForSession(input.code));
  } else if (input.tokenHash && input.type === "recovery") {
    credentialKind = "token_hash";
    ({ error } = await input.auth.verifyOtp({
      token_hash: input.tokenHash,
      type: "recovery"
    }));
  } else {
    error = {
      name: input.providerError
        ? "ProviderRecoveryError"
        : "MissingRecoveryCredentials",
      message: input.providerError
        ? "The authentication provider rejected this recovery link."
        : "The recovery link did not include supported credentials."
    };
  }

  if (!error) {
    const userResult = await input.auth.getUser();
    if (userResult.error || !userResult.data.user) {
      error = userResult.error ?? {
        name: "RecoverySessionMissing",
        message: "The recovery credentials did not create a user session."
      };
    }
  }

  return {
    credentialKind,
    error,
    sessionEstablished: !error
  };
}

export async function updateRecoveryPassword(input: {
  password: unknown;
  confirmPassword: unknown;
  hasRecoveryMarker: boolean;
  getUser: () => Promise<{ user: unknown | null; error: { message?: string } | null }>;
  updateUser: (password: string) => Promise<{ error: { message?: string } | null }>;
}): Promise<{ ok: true } | { ok: false; status: 400 | 401; error: string }> {
  const validationError = validateNewPassword(input);
  if (validationError) return { ok: false, status: 400, error: validationError };
  if (!input.hasRecoveryMarker) {
    return {
      ok: false,
      status: 401,
      error: "Your password-reset session has expired. Request a new link."
    };
  }
  const userResult = await input.getUser();
  if (userResult.error || !userResult.user) {
    return {
      ok: false,
      status: 401,
      error: "Your password-reset session has expired. Request a new link."
    };
  }
  const updateResult = await input.updateUser(input.password as string);
  if (updateResult.error) {
    return {
      ok: false,
      status: 400,
      error: updateResult.error.message || "Unable to update the password."
    };
  }
  return { ok: true };
}
