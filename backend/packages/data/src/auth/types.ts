export const SESSION_PLATFORMS = ["web", "ios", "macos"] as const;
export type SessionPlatform = (typeof SESSION_PLATFORMS)[number];

/** The two ways a request can present a session token: the web session cookie, or `Authorization: Bearer`. */
export type SessionDeliveryChannel = "cookie" | "bearer";

/**
 * The one channel each platform's session token is allowed to travel over (issue #141). A
 * browser never sees its token in a readable response — `login` sets it only as an `httpOnly`
 * cookie — so a web session presented via `Authorization: Bearer` can only mean the cookie leaked
 * or a client is misdeclaring its platform, either way grounds for rejection. iOS/macOS get the
 * token back in the login body for Keychain storage and must use Bearer; a native session
 * presented via cookie is rejected the same way. `authenticateRequest` enforces this after
 * verifying the token itself, so the failure still surfaces as the one generic 401.
 */
export const SESSION_DELIVERY_CHANNEL_BY_PLATFORM: Record<SessionPlatform, SessionDeliveryChannel> = {
  web: "cookie",
  ios: "bearer",
  macos: "bearer",
};

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  locale: string;
  createdAt: string;
}

export interface SessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  platform: SessionPlatform;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  revokedAt: string | null;
}

export interface LoginAttemptRow {
  id: string;
  email: string;
  ip: string;
  succeeded: boolean;
  attemptedAt: string;
}

export interface PasswordResetTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}
