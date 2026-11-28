import type { PublicUser } from "./authActions.js";
import type { SessionPlatform } from "./types.js";

/**
 * `WKScriptMessageHandlerWithReply` name the native shell exposes to the embedded web editor,
 * which uses it instead of `POST /api/auth/login`:
 *
 * ```js
 * const reply = await window.webkit.messageHandlers[NATIVE_SESSION_BRIDGE_HANDLER_NAME].postMessage({});
 * // reply: NativeSessionBridgeReply
 * ```
 *
 * Security: the host registers it only on the editor's `WKWebView` and exposes the token by no
 * other route (no query string, injected global or localStorage). The reply mirrors the native
 * login response; the editor keeps the token in memory only (the Keychain owns persistence) and
 * never falls back to `/api/auth/login` while the bridge is present.
 */
export const NATIVE_SESSION_BRIDGE_HANDLER_NAME = "alldotsNativeSession";

export interface NativeSessionBridgeReply {
  token: string;
  platform: Extract<SessionPlatform, "ios" | "macos">;
  user: PublicUser;
}
