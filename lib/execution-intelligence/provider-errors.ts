import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError
} from "openai";

/** Transient provider/transport failures that a fresh attempt can be expected to clear. Anything
 * else (4xx other than 408/429, aborts, SDK finish-reason errors, application errors) is not
 * classified and keeps its caller's handled-failure semantics. */
export type RetryableProviderFailure =
  | { kind: "http"; status: number }
  | { kind: "connection" }
  | { kind: "timeout" };

const RETRYABLE_HTTP_STATUSES = new Set([408, 429]);

/** Node/undici socket-level codes. The OpenAI SDK normally wraps these in APIConnectionError;
 * these cover a raw transport error reaching the caller unwrapped. */
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "EAI_AGAIN", "ENETUNREACH",
  "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CLOSED"
]);
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"
]);

function transportErrorCode(error: unknown): string | null {
  // fetch reports socket failures as TypeError("fetch failed") with the code on `cause`.
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 3; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && (NETWORK_ERROR_CODES.has(code) || TIMEOUT_ERROR_CODES.has(code))) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Classifies by error type, status and transport code only; never by message text. */
export function classifyRetryableProviderError(error: unknown): RetryableProviderFailure | null {
  if (error instanceof APIUserAbortError) return null;
  if (error instanceof APIConnectionTimeoutError) return { kind: "timeout" };
  if (error instanceof APIConnectionError) return { kind: "connection" };
  if (error instanceof APIError) {
    const status = error.status;
    if (typeof status !== "number") return null;
    return RETRYABLE_HTTP_STATUSES.has(status) || (status >= 500 && status <= 599)
      ? { kind: "http", status }
      : null;
  }
  const code = transportErrorCode(error);
  if (!code) return null;
  return TIMEOUT_ERROR_CODES.has(code) ? { kind: "timeout" } : { kind: "connection" };
}

function describeFailure(failure: RetryableProviderFailure) {
  if (failure.kind === "http") return `HTTP ${failure.status}`;
  return failure.kind === "timeout" ? "request timeout" : "connection failure";
}

/** Thrown (not returned) so a durable unit's Workflow step retries it. The message carries only
 * the classification, never provider text, headers or request bodies. */
export class RetryableProviderError extends Error {
  constructor(operation: string, readonly failure: RetryableProviderFailure) {
    super(`${operation} hit a retryable provider error (${describeFailure(failure)}).`);
    this.name = "RetryableProviderError";
  }
}
