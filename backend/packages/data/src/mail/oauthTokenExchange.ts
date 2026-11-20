import {
  assertJsonObject,
  MailAdminConsentRequiredError,
  MailAuthorizationCodeRejectedError,
  MailReauthorizationRequiredError,
} from "./providerTypes.js";
import { logger } from "./logger.js";

/**
 * OAuth2 refresh-token grant (RFC 6749 §6), shared by the Gmail and Graph clients. The access token is
 * computed at runtime and never persisted; client credentials are never logged.
 */
export interface RefreshAccessTokenInput {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scope?: string;
  /** Tests inject a fake endpoint here. */
  fetchImpl?: typeof fetch;
}

export interface AccessToken {
  accessToken: string;
  expiresAt: Date;
  /** Present only when returned non-empty (Microsoft rotates it on every refresh). */
  refreshToken?: string;
}

class OAuthRefreshBodyTooLargeError extends Error {
  constructor() {
    super("OAuth token refresh response exceeds the size limit");
  }
}

function refreshDiagnostic(stage: "request" | "cleanup", observed: unknown[]): void {
  try {
    logger.warn({ stage }, "OAuth refresh reported a failure");
  } catch (diagnosticError) {
    observed.push(diagnosticError);
  }
}

export async function refreshAccessToken(input: RefreshAccessTokenInput): Promise<AccessToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    ...(input.scope ? { scope: input.scope } : {}),
  });

  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    let response: Response;
    try {
      response = await doFetch(input.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      const observed: unknown[] = [error];
      refreshDiagnostic("request", observed);
      void observed;
      // A provider error can contain credentials or response data.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("OAuth token refresh request failed");
    }
    if (!response.ok) {
      // Only the status is thrown, never the body. 400/401 is Google's and Microsoft's status for a
      // revoked/expired refresh token: a credential problem for the user, not worth retrying.
      controller.abort();
      try {
        await response.body?.cancel();
      } catch (error) {
        const observed: unknown[] = [error];
        refreshDiagnostic("cleanup", observed);
        void observed;
      }
      if (response.status === 400 || response.status === 401) {
        throw new MailReauthorizationRequiredError(
          `OAuth token refresh rejected the stored refresh token (status ${response.status})`,
        );
      }
      throw new Error(`OAuth token refresh failed with status ${response.status}`);
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    if (!reader) throw new Error("OAuth token refresh response has no body");
    const chunks: Uint8Array[] = [];
    let length = 0;
    const tooLarge = new OAuthRefreshBodyTooLargeError();
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > 64 * 1024) throw tooLarge;
        chunks.push(result.value);
      }
    } catch (error) {
      const observed: unknown[] = [error];
      controller.abort();
      try {
        await reader.cancel();
      } catch (cleanupError) {
        observed.push(cleanupError);
        refreshDiagnostic("cleanup", observed);
      }
      try {
        reader.releaseLock();
      } catch (cleanupError) {
        observed.push(cleanupError);
        refreshDiagnostic("cleanup", observed);
      }
      void observed;
      if (error === tooLarge) throw error;
      // A stream error can contain the provider response or credentials.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("OAuth token refresh response could not be read");
    }
    try {
      reader.releaseLock();
    } catch (error) {
      const observed: unknown[] = [error];
      refreshDiagnostic("cleanup", observed);
      void observed;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("OAuth token refresh response could not be released");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("OAuth token refresh response is not valid JSON");
    }
    const json = assertJsonObject(parsed, "OAuth token refresh response");
    if (typeof json.access_token !== "string" || !json.access_token) {
      throw new Error("OAuth token refresh response is missing a string access_token");
    }
    if (typeof json.expires_in !== "number" || !Number.isFinite(json.expires_in)) {
      throw new Error("OAuth token refresh response is missing a numeric expires_in");
    }
    const expiresAt = new Date(Date.now() + json.expires_in * 1000);
    if (typeof json.refresh_token === "string" && json.refresh_token) {
      return { accessToken: json.access_token, expiresAt, refreshToken: json.refresh_token };
    }
    return { accessToken: json.access_token, expiresAt };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export interface ExchangeAuthorizationCodeInput {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}

export interface AuthorizationCodeTokens {
  accessToken: string;
  expiresAt: Date;
  refreshToken: string;
  /** The response's space-separated `scope`; `null` when it has none. */
  grantedScopes: string[] | null;
}

/** Far above the handful of scopes a sign-in asks for; bounds what one response can store. */
const MAX_GRANTED_SCOPES = 64;
const MAX_SCOPE_LENGTH = 512;

function parseGrantedScopes(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("OAuth code exchange response has a non-string scope");
  const scopes = [...new Set(value.split(/\s+/).filter((scope) => scope.length > 0))];
  if (scopes.length > MAX_GRANTED_SCOPES || scopes.some((scope) => scope.length > MAX_SCOPE_LENGTH)) {
    throw new Error("OAuth code exchange response has a scope above the size limit");
  }
  return scopes;
}

const PROVIDER_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "consent_required",
]);
const ADMIN_CONSENT_MARKERS = ["AADSTS65001", "AADSTS90094"];

const AUTHORIZATION_RESPONSE_LIMIT_BYTES = 64 * 1024;

function authorizationCleanupDiagnostic(
  stage: "reader_cancel" | "reader_release" | "response_cancel",
  observed: unknown[],
): void {
  try {
    if (!logger.isLevelEnabled("error")) throw new Error("OAuth cleanup diagnostic is disabled");
    logger.error({ stage }, "OAuth code exchange cleanup failed");
  } catch (diagnosticError) {
    observed.push(diagnosticError);
  }
}

async function readAuthorizationBody(response: Response): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) throw new Error("OAuth code exchange response has no body");
  const chunks: Uint8Array[] = [];
  const failures: unknown[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > AUTHORIZATION_RESPONSE_LIMIT_BYTES)
        throw new Error("OAuth code exchange response exceeds size limit");
      chunks.push(result.value);
    }
  } catch (error) {
    failures.push(error);
    try {
      await reader.cancel();
    } catch (cleanupError) {
      failures.push(cleanupError);
      authorizationCleanupDiagnostic("reader_cancel", failures);
    }
  }
  try {
    reader.releaseLock();
  } catch (cleanupError) {
    failures.push(cleanupError);
    authorizationCleanupDiagnostic("reader_release", failures);
  }
  if (failures.length) {
    // Raw body and cleanup failures stay local to this privacy boundary.
    throw new Error("OAuth code exchange response could not be read");
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readProviderError(response: Response): Promise<{ code: string | null; adminConsent: boolean }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readAuthorizationBody(response));
  } catch {
    // A non-JSON error body only costs the classification detail; the status still decides the error.
    return { code: null, adminConsent: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { code: null, adminConsent: false };
  const { error, error_description: description } = parsed as Record<string, unknown>;
  const code = typeof error === "string" && PROVIDER_ERROR_CODES.has(error) ? error : null;
  const adminConsent =
    code === "consent_required" ||
    (code === "invalid_grant" &&
      typeof description === "string" &&
      ADMIN_CONSENT_MARKERS.some((marker) => description.includes(marker)));
  return { code, adminConsent };
}

/**
 * `authorization_code` grant with PKCE. Persists nothing. No thrown message contains the code,
 * verifier, client secret or any token: only the status and the provider's short error code.
 */
export async function exchangeAuthorizationCode(
  input: ExchangeAuthorizationCodeInput,
): Promise<AuthorizationCodeTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  });

  const doFetch = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(input.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Provider and network failures may include submitted credentials.
    throw new Error("OAuth code exchange request failed");
  }
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      const { code: providerCode, adminConsent } = await readProviderError(response);
      // Classified from the unredacted code: a `code` that is a substring of the provider's error token
      // blanks `code` below, and the refused grant must still be recognized.
      const grantRefused = providerCode === "invalid_grant";
      const code =
        providerCode &&
        [input.code, input.codeVerifier, input.clientSecret].some(
          (secret) => secret.length > 0 && providerCode.includes(secret),
        )
          ? null
          : providerCode;
      const detail = `status ${response.status}${code ? `, error ${code}` : ""}`;
      if (adminConsent) {
        throw new MailAdminConsentRequiredError(`OAuth code exchange needs administrator consent (${detail})`, code);
      }
      throw new MailAuthorizationCodeRejectedError(
        `OAuth code exchange rejected the authorization code (${detail})`,
        code,
        grantRefused,
      );
    }
    const cleanupFailures: unknown[] = [];
    try {
      await response.body?.cancel();
    } catch (error) {
      cleanupFailures.push(error);
      authorizationCleanupDiagnostic("response_cancel", cleanupFailures);
    }
    void cleanupFailures;
    throw new Error(`OAuth code exchange failed with status ${response.status}`);
  }
  let responseBody: string;
  try {
    responseBody = await readAuthorizationBody(response);
  } catch {
    throw new Error("OAuth code exchange response could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    throw new Error("OAuth code exchange response is not valid JSON");
  }
  const json = assertJsonObject(parsed, "OAuth code exchange response");
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new Error("OAuth code exchange response is missing a string access_token");
  }
  if (typeof json.expires_in !== "number" || !Number.isFinite(json.expires_in)) {
    throw new Error("OAuth code exchange response is missing a numeric expires_in");
  }
  if (typeof json.refresh_token !== "string" || !json.refresh_token) {
    throw new Error("OAuth code exchange response is missing a string refresh_token");
  }
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    refreshToken: json.refresh_token,
    grantedScopes: parseGrantedScopes(json.scope),
  };
}

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
