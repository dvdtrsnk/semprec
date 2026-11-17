export const SESSION_PLATFORMS = ["web", "ios", "macos"] as const;
export type SessionPlatform = (typeof SESSION_PLATFORMS)[number];

export type SessionDeliveryChannel = "cookie" | "bearer";

/**
 * The only channel each platform's token may arrive on. A web token arrives only as an `httpOnly`
 * cookie, so a web session over Bearer means a leak or a misdeclared platform; it is rejected with
 * the generic 401, and so is a native session over cookie.
 */
export const SESSION_DELIVERY_CHANNEL_BY_PLATFORM: Record<SessionPlatform, SessionDeliveryChannel> = {
  web: "cookie",
  ios: "bearer",
  macos: "bearer",
};

export const SESSION_DEVICE_KINDS = ["iphone", "ipad", "mac", "browser"] as const;
export type SessionDeviceKind = (typeof SESSION_DEVICE_KINDS)[number];

export type UserRole = "admin" | "member";

export interface UserRow {
  id: string;
  email: string;
  /** `null` until one is set. */
  displayName: string | null;
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
  deviceId: string | null;
  deviceName: string | null;
  deviceKind: SessionDeviceKind | null;
  osVersion: string | null;
  appVersion: string | null;
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
