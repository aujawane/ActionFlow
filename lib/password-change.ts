import { validateNewPassword } from "@/lib/password-recovery";

/**
 * Signed-in password change (Flow A).
 *
 * Supabase decides whether reauthentication is required, and this flow follows its answer:
 *   1. auth.updateUser({ password })
 *        - succeeds          -> done. Recently signed-in session (or Secure password change off);
 *                               no code is sent or asked for.
 *        - reauthentication_needed
 *                            -> 2. auth.reauthenticate(): Supabase emails its "Reauthentication"
 *                                  template with a code, and the UI shows the code step.
 *   3. auth.updateUser({ password, nonce: code })  (only reached when Supabase demanded it)
 *
 * The client never guesses session age itself; reauthentication_needed from Supabase is the
 * only trigger for the code step. That way the code step appears exactly when Supabase is going to
 * enforce the nonce, and the UI never implies a code was checked when it was not.
 *
 * Deliberately separate from the signed-out recovery flow (lib/password-recovery.ts,
 * resetPasswordForEmail). Never uses resetPasswordForEmail, signInWithOtp, verifyOtp or any
 * service-role API, and never sends, stores or logs the code or the password: both live only in
 * this controller's memory until success, close or reset clears them.
 */

export const PASSWORD_CHANGE_RESEND_COOLDOWN_SECONDS = 60;

export const PASSWORD_CHANGED_NOTICE =
  "Your password has been changed. Use it the next time you sign in.";

export type AuthLikeError = {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
};

type AuthResult = { error: AuthLikeError | null };

/** The subset of supabase.auth this flow needs. supabase.auth satisfies it structurally. */
export type PasswordChangeAuth = {
  reauthenticate(): Promise<AuthResult>;
  updateUser(attributes: { password: string; nonce?: string }): Promise<AuthResult>;
};

export type PasswordChangeStep = "enter-password" | "enter-code" | "done";

export type PasswordChangeState = {
  step: PasswordChangeStep;
  newPassword: string;
  confirmPassword: string;
  verificationCode: string;
  /**
   * "update": first updateUser({ password }); "send": reauthenticate() after Supabase required
   * it; "resend": user-requested new code; "verify": updateUser({ password, nonce }).
   */
  pending: null | "update" | "send" | "resend" | "verify";
  error: string | null;
  notice: string | null;
  /** Epoch ms before which "Resend code" stays disabled. */
  resendAvailableAt: number | null;
};

/**
 * Audit events. account_verification_events only allows a fixed set of event_type values, so how
 * the change was authorized is recorded in metadata ("recent_session" vs "reauthentication_code")
 * rather than in a new event type.
 */
export type PasswordChangeEvent =
  | { type: "password_code_requested" }
  | { type: "password_change_verified"; method: "recent_session" | "reauthentication_code" }
  | { type: "password_change_failed"; reason: string };

export type PasswordChangeField = "newPassword" | "confirmPassword" | "verificationCode";

export const INITIAL_PASSWORD_CHANGE_STATE: PasswordChangeState = {
  step: "enter-password",
  newPassword: "",
  confirmPassword: "",
  verificationCode: "",
  pending: null,
  error: null,
  notice: null,
  resendAvailableAt: null
};

const NETWORK_ERROR_MESSAGE =
  "We couldn't reach the server. Check your connection and try again.";

function isRateLimited(error: AuthLikeError) {
  return (
    error.status === 429 ||
    error.code === "over_email_send_rate_limit" ||
    error.code === "over_request_rate_limit"
  );
}

function isNetworkFailure(error: AuthLikeError) {
  // supabase-js reports fetch failures as AuthRetryableFetchError (status 0 when offline).
  return error.name === "AuthRetryableFetchError" || error.status === 0;
}

function isSessionMissing(error: AuthLikeError) {
  return (
    error.name === "AuthSessionMissingError" ||
    error.code === "session_not_found" ||
    error.code === "session_expired"
  );
}

/** Supabase's authoritative signal that this session must reauthenticate with an emailed code. */
export function requiresReauthentication(error: AuthLikeError | null | undefined): boolean {
  return error?.code === "reauthentication_needed";
}

function isCodeRejected(error: AuthLikeError) {
  return error.code === "reauthentication_not_valid" || error.code === "otp_expired";
}

/** Maps a reauthenticate() failure to a message a user can act on. */
export function describeSendCodeError(error: AuthLikeError): string {
  if (isNetworkFailure(error)) return NETWORK_ERROR_MESSAGE;
  if (isRateLimited(error)) {
    return "Too many verification emails were requested. Wait a minute, then try again.";
  }
  if (isSessionMissing(error)) {
    return "Your session has ended. Sign in again to change your password.";
  }
  return "We couldn't send a verification code right now. Please try again.";
}

/** Maps an updateUser(...) failure to a message a user can act on. */
export function describeUpdatePasswordError(error: AuthLikeError): string {
  if (isNetworkFailure(error)) return NETWORK_ERROR_MESSAGE;
  if (isCodeRejected(error)) {
    return /expired/i.test(error.message ?? "") || error.code === "otp_expired"
      ? "That verification code has expired. Request a new code and try again."
      : "That verification code is invalid or has expired. Check the latest email, or request a new code.";
  }
  if (error.code === "reauthentication_needed" || error.code === "reauth_nonce_missing") {
    return "Please request a new verification code, then try again.";
  }
  if (error.code === "weak_password") {
    return "That password is too weak. Choose a longer password that is harder to guess.";
  }
  if (error.code === "same_password") {
    return "Your new password must be different from your current password.";
  }
  if (isRateLimited(error)) {
    return "Too many attempts. Wait a minute, then try again.";
  }
  if (isSessionMissing(error)) {
    return "Your session has ended. Sign in again to change your password.";
  }
  return "We couldn't change your password. Please try again.";
}

/** Diagnostic-only logging in development: error metadata, never passwords, codes or tokens. */
function logDiagnostic(stage: "update" | "send" | "resend" | "verify", error: AuthLikeError) {
  if (process.env.NODE_ENV !== "development") return;
  console.info("[password-change] failed", {
    stage,
    error_name: error.name,
    error_code: error.code,
    error_status: error.status,
    error_message: error.message
  });
}

function toAuthError(thrown: unknown): AuthLikeError {
  // A raw fetch TypeError (offline, DNS, CORS) is a network failure from the user's view.
  if (thrown instanceof TypeError) return { name: "AuthRetryableFetchError", status: 0 };
  if (thrown && typeof thrown === "object") {
    const candidate = thrown as AuthLikeError;
    return {
      name: candidate.name,
      message: candidate.message,
      status: candidate.status,
      code: candidate.code
    };
  }
  return { name: "UnknownError" };
}

async function call(fn: () => Promise<AuthResult>): Promise<AuthLikeError | null> {
  try {
    return (await fn()).error;
  } catch (thrown) {
    return toAuthError(thrown);
  }
}

export type PasswordChangeController = ReturnType<typeof createPasswordChangeController>;

export function createPasswordChangeController(input: {
  auth: PasswordChangeAuth;
  email: string;
  onEvent?: (event: PasswordChangeEvent) => void;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let state: PasswordChangeState = INITIAL_PASSWORD_CHANGE_STATE;
  // Synchronous guard: React state updates are async, so a fast double click could otherwise
  // start two requests before the disabled button re-renders.
  let inFlight = false;
  const listeners = new Set<() => void>();

  function setState(patch: Partial<PasswordChangeState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function emit(event: PasswordChangeEvent) {
    try {
      input.onEvent?.(event);
    } catch {
      // Audit logging is best-effort and must never break the password flow.
    }
  }

  function secondsUntilResend() {
    if (state.resendAvailableAt === null) return 0;
    return Math.max(0, Math.ceil((state.resendAvailableAt - now()) / 1000));
  }

  function cooldownFrom(error: AuthLikeError | null) {
    return error && !isRateLimited(error)
      ? state.resendAvailableAt
      : now() + PASSWORD_CHANGE_RESEND_COOLDOWN_SECONDS * 1000;
  }

  function validatePasswords() {
    const validationError = validateNewPassword({
      password: state.newPassword,
      confirmPassword: state.confirmPassword
    });
    if (validationError) setState({ error: validationError, notice: null });
    return !validationError;
  }

  function succeed(method: "recent_session" | "reauthentication_code") {
    // Wipe every sensitive value. The "done" step makes any further submit a no-op until reset.
    emit({ type: "password_change_verified", method });
    setState({ ...INITIAL_PASSWORD_CHANGE_STATE, step: "done", notice: PASSWORD_CHANGED_NOTICE });
  }

  function fail(stage: "update" | "verify", error: AuthLikeError) {
    logDiagnostic(stage, error);
    emit({ type: "password_change_failed", reason: error.code ?? error.name ?? "unknown" });
    setState({
      pending: null,
      error: describeUpdatePasswordError(error),
      verificationCode: isCodeRejected(error) ? "" : state.verificationCode
    });
  }

  /** Asks Supabase to email a code. Only called after Supabase said reauthentication is needed. */
  async function sendCode(kind: "send" | "resend") {
    setState({ pending: kind, error: null, notice: null });
    const error = await call(() => input.auth.reauthenticate());
    if (error) {
      logDiagnostic(kind, error);
      setState({
        pending: null,
        error: describeSendCodeError(error),
        resendAvailableAt: cooldownFrom(error)
      });
      return false;
    }
    emit({ type: "password_code_requested" });
    setState({
      step: "enter-code",
      pending: null,
      // A new code replaces the previous one, so never keep a stale code in the field.
      verificationCode: "",
      notice:
        kind === "resend"
          ? `We sent a new verification code to ${input.email}.`
          : `For your security, confirm it's you: we sent a verification code to ${input.email}.`,
      resendAvailableAt: cooldownFrom(null)
    });
    return true;
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setField(field: PasswordChangeField, value: string) {
      if (state.step === "done") return;
      setState({ [field]: value });
    },

    secondsUntilResend,

    /**
     * Step 1: try the change directly. Supabase either accepts it (recent session) or answers
     * reauthentication_needed, in which case a code is requested and the code step is shown.
     */
    async submitPassword() {
      if (inFlight || state.step !== "enter-password") return false;
      if (!validatePasswords()) return false;

      inFlight = true;
      try {
        setState({ pending: "update", error: null, notice: null });
        const error = await call(() => input.auth.updateUser({ password: state.newPassword }));
        if (!error) {
          succeed("recent_session");
          return true;
        }
        if (requiresReauthentication(error)) {
          await sendCode("send");
          return false;
        }
        fail("update", error);
        return false;
      } finally {
        inFlight = false;
      }
    },

    /** Step 2 (only after reauthentication_needed): password plus the emailed code as nonce. */
    async submitCode() {
      if (inFlight || state.step !== "enter-code") return false;
      if (!validatePasswords()) return false;
      const nonce = state.verificationCode.replace(/\s+/g, "");
      if (!nonce) {
        setState({ error: "Enter the verification code from your email.", notice: null });
        return false;
      }

      inFlight = true;
      try {
        setState({ pending: "verify", error: null, notice: null });
        const error = await call(() =>
          input.auth.updateUser({ password: state.newPassword, nonce })
        );
        if (!error) {
          succeed("reauthentication_code");
          return true;
        }
        fail("verify", error);
        return false;
      } finally {
        inFlight = false;
      }
    },

    async resendCode() {
      if (inFlight || state.step !== "enter-code" || secondsUntilResend() > 0) return false;
      inFlight = true;
      try {
        return await sendCode("resend");
      } finally {
        inFlight = false;
      }
    },

    /** Clears everything, including any typed passwords or code (used on close). */
    reset() {
      if (inFlight) return;
      setState({ ...INITIAL_PASSWORD_CHANGE_STATE });
    }
  };
}

/**
 * Whether the account has an email/password credential that "Change password" applies to.
 *
 * Google-only accounts (created through Google Sign In) have only a "google" identity and no
 * Parfait password, so they are not offered Change Password. Accounts that started with email
 * and password and later also used Google keep "email" in their providers and still see it.
 */
export function hasPasswordCredential(user: {
  email?: string | null;
  app_metadata?: { provider?: unknown; providers?: unknown } | null;
  identities?: Array<{ provider?: string | null }> | null;
}): boolean {
  if (!user.email) return false;
  const providers = user.app_metadata?.providers;
  if (Array.isArray(providers) && providers.length > 0) return providers.includes("email");
  if (Array.isArray(user.identities) && user.identities.length > 0) {
    return user.identities.some((identity) => identity.provider === "email");
  }
  const provider = user.app_metadata?.provider;
  return provider === undefined || provider === null || provider === "email";
}
