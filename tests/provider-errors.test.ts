import assert from "node:assert/strict";
import test from "node:test";

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError
} from "openai";
import { LengthFinishReasonError } from "openai/error";

import {
  classifyRetryableProviderError,
  RetryableProviderError
} from "../lib/execution-intelligence/provider-errors";

/** The exact SDK path for an HTTP error response (status + headers -> typed subclass). */
const httpError = (status: number, message = "provider said no") =>
  APIError.generate(status, undefined, message, { "x-request-id": "req_secretish" });
const withCode = (code: string, message = "transport") => Object.assign(new Error(message), { code });

test("[1][2] 503 and every other 5xx are retryable HTTP failures", () => {
  const unavailable = httpError(503, "no healthy upstream");
  assert.equal(unavailable.message, "503 no healthy upstream", "the generation-20 error shape");
  assert.deepEqual(classifyRetryableProviderError(unavailable), { kind: "http", status: 503 });
  for (const status of [500, 502, 504, 520, 599]) {
    assert.deepEqual(classifyRetryableProviderError(httpError(status)), { kind: "http", status });
  }
});

test("[3] 429 rate limiting and 408 request timeout are retryable", () => {
  assert.deepEqual(classifyRetryableProviderError(httpError(429)), { kind: "http", status: 429 });
  assert.deepEqual(classifyRetryableProviderError(httpError(408)), { kind: "http", status: 408 });
});

test("[4] connection and raw transport failures are retryable", () => {
  assert.deepEqual(classifyRetryableProviderError(new APIConnectionError({ message: "Connection error." })), { kind: "connection" });
  // No status/headers: the SDK's own generate() yields a connection error.
  assert.deepEqual(classifyRetryableProviderError(APIError.generate(undefined, undefined, "boom", undefined)), { kind: "connection" });
  for (const code of ["ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
    assert.deepEqual(classifyRetryableProviderError(withCode(code)), { kind: "connection" }, code);
  }
  // undici: TypeError("fetch failed") with the socket error on `cause`.
  const fetchFailed = Object.assign(new TypeError("fetch failed"), { cause: withCode("ECONNRESET") });
  assert.deepEqual(classifyRetryableProviderError(fetchFailed), { kind: "connection" });
});

test("[5] SDK and transport timeouts are retryable timeouts", () => {
  assert.deepEqual(classifyRetryableProviderError(new APIConnectionTimeoutError()), { kind: "timeout" });
  for (const code of ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
    assert.deepEqual(classifyRetryableProviderError(withCode(code)), { kind: "timeout" }, code);
  }
});

test("[14] non-transient errors are not classified: client 4xx, aborts, finish reasons, application errors", () => {
  for (const status of [400, 401, 403, 404, 409, 413, 422]) {
    assert.equal(classifyRetryableProviderError(httpError(status)), null, String(status));
  }
  const notRetryable: unknown[] = [
    new APIUserAbortError(),
    new LengthFinishReasonError(),
    new Error("socket hang up"),
    new Error("Request timed out"),
    new SyntaxError("Unexpected token"),
    withCode("ENOENT"),
    Object.assign(new Error("x"), { status: 503 }),
    { status: 503 },
    "503",
    null,
    undefined
  ];
  for (const error of notRetryable) {
    assert.equal(classifyRetryableProviderError(error), null, String((error as Error)?.message ?? error));
  }
});

test("RetryableProviderError carries only the classification, never provider text or headers", () => {
  const error = new RetryableProviderError("Conversation event extraction", { kind: "http", status: 503 });
  assert.equal(error.message, "Conversation event extraction hit a retryable provider error (HTTP 503).");
  assert.equal(error.name, "RetryableProviderError");
  assert.equal(error.cause, undefined);
  assert.equal(new RetryableProviderError("X", { kind: "timeout" }).message, "X hit a retryable provider error (request timeout).");
  assert.equal(new RetryableProviderError("X", { kind: "connection" }).message, "X hit a retryable provider error (connection failure).");
  assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /healthy|req_|secret/);
});
