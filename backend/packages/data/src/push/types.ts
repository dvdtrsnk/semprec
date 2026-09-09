import type { SessionPlatform } from "../auth/types.js";

export const PUSH_CHANNELS = ["web_push", "apns"] as const;
export type PushChannel = (typeof PUSH_CHANNELS)[number];

export const APNS_ENVIRONMENTS = ["sandbox", "production"] as const;
export type ApnsEnvironment = (typeof APNS_ENVIRONMENTS)[number];

/** The platform each channel is valid for (migration 0031's `push_subscriptions_channel_platform_chk`). */
export const PLATFORMS_BY_CHANNEL: Record<PushChannel, readonly SessionPlatform[]> = {
  web_push: ["web"],
  apns: ["ios", "macos"],
};

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
