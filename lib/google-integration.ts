import crypto from "node:crypto";

import { getGoogleRedirectUri as resolveGoogleRedirectUri } from "@/lib/env";

export const GOOGLE_INTEGRATION_PROVIDER = "google";
export const GOOGLE_MEET_SCOPE = "https://www.googleapis.com/auth/meetings.space.created";
export const GOOGLE_OAUTH_SCOPES = ["openid", "email", "profile", GOOGLE_MEET_SCOPE].join(" ");

type GoogleStatePayload = {
  userId: string;
  nonce: string;
  createdAt: number;
};

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleUserInfo = {
  email?: string;
  verified_email?: boolean;
};

function getRequiredGoogleEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Configure Google OAuth before connecting Google Meet.`);
  }
  return value;
}

function getStateSecret() {
  return process.env.RECALL_WEBHOOK_SECRET?.trim() || getRequiredGoogleEnv("GOOGLE_CLIENT_SECRET");
}

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signState(payload: string) {
  return crypto.createHmac("sha256", getStateSecret()).update(payload).digest("base64url");
}

export function getGoogleRedirectUri() {
  return resolveGoogleRedirectUri();
}

export function createGoogleOAuthState(userId: string) {
  const payload: GoogleStatePayload = {
    userId,
    nonce: crypto.randomBytes(16).toString("hex"),
    createdAt: Date.now()
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${signState(encodedPayload)}`;
}

export function verifyGoogleOAuthState(state: string, expectedUserId: string) {
  const [encodedPayload, signature] = state.split(".");
  if (!encodedPayload || !signature) return false;

  const expectedSignature = signState(encodedPayload);
  const validSignature =
    Buffer.byteLength(signature) === Buffer.byteLength(expectedSignature) &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  if (!validSignature) return false;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as GoogleStatePayload;
    const stateAgeMs = Date.now() - payload.createdAt;
    return payload.userId === expectedUserId && stateAgeMs >= 0 && stateAgeMs < 10 * 60 * 1000;
  } catch {
    return false;
  }
}

export function createGoogleOAuthUrl(userId: string) {
  const params = new URLSearchParams({
    client_id: getRequiredGoogleEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: getGoogleRedirectUri(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_OAUTH_SCOPES,
    state: createGoogleOAuthState(userId)
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleAuthorizationCode(code: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: getRequiredGoogleEnv("GOOGLE_CLIENT_ID"),
      client_secret: getRequiredGoogleEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: getGoogleRedirectUri()
    })
  });
  const data = (await response.json().catch(() => ({}))) as GoogleTokenResponse;

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        `Google token exchange failed with status ${response.status}.`
    );
  }

  return data;
}

export async function fetchGoogleUserInfo(accessToken: string) {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json().catch(() => null)) as GoogleUserInfo | null;
}
