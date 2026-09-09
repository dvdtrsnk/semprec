import type { SessionPlatform } from "../auth/types.js";

export const PUSH_CHANNELS = ["web_push", "apns"] as const;
export type PushChannel = (typeof PUSH_CHANNELS)[number];

export const APNS_ENVIRONMENTS = ["sandbox", "production"] as const;
export type ApnsEnvironment = (typeof APNS_ENVIRONMENTS)[number];

export interface PushSubscriptionRow {
  id: string;
  userId: string;
  sessionId: string | null;
  channel: PushChannel;
  platform: SessionPlatform;
  endpoint: string | null;
  p256dh: string | null;
  authSecret: string | null;
  deviceToken: string | null;
  apnsEnvironment: ApnsEnvironment | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}
