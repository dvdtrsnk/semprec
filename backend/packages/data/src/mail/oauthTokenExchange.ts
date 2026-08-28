import { assertJsonObject, MailReauthorizationRequiredError } from "./providerTypes.js";

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
    // Never includes `body`/the refresh token itself in the thrown message — only the status.
    // 400/401 is both Google's and Microsoft's documented status for a revoked/expired refresh
    // token (`invalid_grant`) — a credential problem the user must fix, not a transient/network
    // failure worth silently retrying (issue #26: `sync_status = 'needsReauthorization'`).
    if (response.status === 400 || response.status === 401) {
      throw new MailReauthorizationRequiredError(`OAuth token refresh rejected the stored refresh token (status ${response.status})`);
    }
    throw new Error(`OAuth token refresh failed with status ${response.status}`);
  }
  const json = assertJsonObject(await response.json(), `OAuth token refresh response from ${input.tokenUrl}`);
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new Error(`OAuth token refresh response from ${input.tokenUrl} is missing a string access_token`);
  }
  if (typeof json.expires_in !== "number" || !Number.isFinite(json.expires_in)) {
    throw new Error(`OAuth token refresh response from ${input.tokenUrl} is missing a numeric expires_in`);
  }
  return { accessToken: json.access_token, expiresAt: new Date(Date.now() + json.expires_in * 1000) };
}

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
