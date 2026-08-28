import { readJsonWithLimit } from "./httpJson.js";

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
}

export interface AccessToken {
  accessToken: string;
  /** Absolute expiry, derived from the provider's `expires_in` (~1h) at call time. */
  expiresAt: Date;
}

/**
 * `invalid_grant` (RFC 6749 §5.2) is the standard signal that a refresh token has been
 * revoked — the user disconnected the account in Google/Microsoft settings, or the token
 * simply expired from disuse. A distinct error type lets the caller (mailSyncJob.ts) tell this
 * apart from a transient network/server failure: "revocation... is a normal state, not a
 * system error" (issue #26's Credentials section) — the worker should stop retrying and set
 * `syncStatus: 'needsReauthorization'` instead of treating it like any other sync failure.
 */
export class OAuthRevokedError extends Error {
  constructor(reason: string) {
    super(`OAuth refresh token revoked: ${reason}`);
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

  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if (response.status === 400) {
      const errorBody = await readJsonWithLimit<{ error?: string } | null>(response).catch(() => null);
      if (errorBody?.error === "invalid_grant") throw new OAuthRevokedError(input.tokenUrl);
    }
    // Never includes `body`/the refresh token itself in the thrown message — only the status.
    throw new Error(`OAuth token refresh failed with status ${response.status}`);
  }
  const json = await readJsonWithLimit<Record<string, unknown> | null>(response);
  if (typeof json?.access_token !== "string" || typeof json?.expires_in !== "number") {
    throw new Error("OAuth token refresh response is missing 'access_token'/'expires_in'");
  }
  return { accessToken: json.access_token, expiresAt: new Date(Date.now() + json.expires_in * 1000) };
}

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
