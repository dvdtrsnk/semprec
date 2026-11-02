import {
  assertJsonObject,
  MailAdminConsentRequiredError,
  MailAuthorizationCodeRejectedError,
  MailReauthorizationRequiredError,
} from "./providerTypes.js";
import { logger } from "./logger.js";

/**
 * Generic OAuth2 refresh-token -> access-token exchange (issue #26: "the access token is
 * computed at runtime and never persisted"). Used by both the Gmail and Graph REST clients
 * — the grant itself (RFC 6749 §6) is identical across providers, only the token endpoint
 * and client credentials differ. `clientId`/`clientSecret` are read from the caller's own
 * environment (not `ai-gateway`'s — these aren't AI provider credentials), never logged.
 */
export interface RefreshAccessTokenInput {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scope?: string;
  /** Replaces the global `fetch` for the token request. Tests inject a fake endpoint here; production leaves it unset. */
  fetchImpl?: typeof fetch;
}

export interface AccessToken {
  accessToken: string;
  /** Absolute expiry, derived from the provider's `expires_in` (~1h) at call time. */
  expiresAt: Date;
  /** Present only when the provider returned a non-empty `refresh_token` (Microsoft rotates it on every refresh). */
  refreshToken?: string;
}

class OAuthRefreshBodyTooLargeError extends Error {
  constructor() {
    super("OAuth token refresh response exceeds the size limit");
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
      logger.warn({ errorCategory: error instanceof Error ? "error" : "non_error" }, "OAuth refresh request failed");
      // A provider error can contain credentials or response data.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("OAuth token refresh request failed");
    }
    if (!response.ok) {
      // Never includes `body`/the refresh token itself in the thrown message — only the status.
      // 400/401 is both Google's and Microsoft's documented status for a revoked/expired refresh
      // token (`invalid_grant`) — a credential problem the user must fix, not a transient/network
      // failure worth silently retrying (issue #26: `sync_status = 'needsReauthorization'`).
      controller.abort();
      try {
        await response.body?.cancel();
      } catch (error) {
        logger.warn({ errorCategory: error instanceof Error ? "error" : "non_error" }, "OAuth response cleanup failed");
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
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > 64 * 1024) throw new OAuthRefreshBodyTooLargeError();
        chunks.push(result.value);
      }
    } catch (error) {
      controller.abort();
      try {
        await reader.cancel();
      } catch (cleanupError) {
        logger.warn(
          { errorCategory: cleanupError instanceof Error ? "error" : "non_error" },
          "OAuth response cleanup failed",
        );
      }
      reader.releaseLock();
      if (error instanceof OAuthRefreshBodyTooLargeError) throw error;
      // A stream error can contain the provider response or credentials.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("OAuth token refresh response could not be read");
    }
    reader.releaseLock();
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
  /** The PKCE verifier whose S256 challenge was sent on the authorization request. */
  codeVerifier: string;
}

export interface AuthorizationCodeTokens {
  accessToken: string;
  expiresAt: Date;
  refreshToken: string;
}

const PROVIDER_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ADMIN_CONSENT_MARKERS = ["AADSTS65001", "AADSTS90094"];

/** Reads only the provider's short `error` code and whether the description names an admin-consent AADSTS code. */
async function readProviderError(response: Response): Promise<{ code: string | null; adminConsent: boolean }> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    // A non-JSON error body only costs the classification detail; the status still decides the error.
    return { code: null, adminConsent: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { code: null, adminConsent: false };
  const { error, error_description: description } = parsed as Record<string, unknown>;
  const code = typeof error === "string" && PROVIDER_ERROR_CODE.test(error) ? error : null;
  const adminConsent =
    code === "consent_required" ||
    (code === "invalid_grant" &&
      typeof description === "string" &&
      ADMIN_CONSENT_MARKERS.some((marker) => description.includes(marker)));
  return { code, adminConsent };
}

/**
 * OAuth2 `authorization_code` grant with PKCE (RFC 6749 §4.1.3, RFC 7636 §4.5). Persists
 * nothing; the caller stores the refresh token. No thrown message contains the code, verifier,
 * client secret or any token: only the status and the provider's short error code.
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

  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      const { code, adminConsent } = await readProviderError(response);
      const detail = `status ${response.status}${code ? `, error ${code}` : ""}`;
      if (adminConsent) {
        throw new MailAdminConsentRequiredError(`OAuth code exchange needs administrator consent (${detail})`, code);
      }
      throw new MailAuthorizationCodeRejectedError(
        `OAuth code exchange rejected the authorization code (${detail})`,
        code,
      );
    }
    throw new Error(`OAuth code exchange failed with status ${response.status}`);
  }
  const json = assertJsonObject(await response.json(), `OAuth code exchange response from ${input.tokenUrl}`);
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new Error(`OAuth code exchange response from ${input.tokenUrl} is missing a string access_token`);
  }
  if (typeof json.expires_in !== "number" || !Number.isFinite(json.expires_in)) {
    throw new Error(`OAuth code exchange response from ${input.tokenUrl} is missing a numeric expires_in`);
  }
  if (typeof json.refresh_token !== "string" || !json.refresh_token) {
    throw new Error(`OAuth code exchange response from ${input.tokenUrl} is missing a string refresh_token`);
  }
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    refreshToken: json.refresh_token,
  };
}

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
