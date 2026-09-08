export const SESSION_PLATFORMS = ["web", "ios", "macos"] as const;
export type SessionPlatform = (typeof SESSION_PLATFORMS)[number];

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
