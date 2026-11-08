import type { PublicUser } from "./authActions.js";
import type { SessionPlatform } from "./types.js";

/**
 * Contract for the bridge the native iOS/macOS shell (issue #141) exposes to the embedded
 * WKWebView that hosts the web editor. The editor is the same web app that also runs standalone
 * in a browser; when it detects it is running inside the native shell, it must use this bridge
 * instead of calling `POST /api/auth/login` — the embedded editor has no login endpoint of its
 * own, because the user already authenticated once, natively, before the shell ever loaded it.
 *
 * Direction: `WKScriptMessageHandlerWithReply` only carries messages from the page's JavaScript
 * to the native host, with the host's return value delivered back as the resolution of the
 * `postMessage` promise — there is no separate push channel. So the editor asks for the session
 * by posting a request with no payload, and the native host replies with the token in the same
 * round trip:
 *
 * ```js
 * const reply = await window.webkit.messageHandlers[NATIVE_SESSION_BRIDGE_HANDLER_NAME].postMessage({});
 * // reply: NativeSessionBridgeReply
 * ```
 *
 * The native host registers this handler only on the `WKWebView` instance that loads the
 * embedded editor — never on any general-purpose in-app browser — and must not otherwise expose
 * the token to the page (no query string, no `WKUserScript`-injected global, no localStorage
 * seeding), so the token's only path onto the page is this one explicit request/reply.
 *
 * The reply shape mirrors `POST /api/auth/login`'s native (`ios`/`macos`) response body, so the
 * editor can treat a bridge reply exactly like a native login result: keep the token in memory
 * for the life of the page and send it as `Authorization: Bearer` on every API call, per
 * `SESSION_DELIVERY_CHANNEL_BY_PLATFORM`. It never persists the token itself — the native host
 * already owns that in the Keychain — and it never falls back to `/api/auth/login` if the bridge
 * is present, even if the reply is slow or the app is offline.
 */
export const NATIVE_SESSION_BRIDGE_HANDLER_NAME = "semprecNativeSession";

export interface NativeSessionBridgeReply {
  token: string;
  platform: Extract<SessionPlatform, "ios" | "macos">;
  user: PublicUser;
}
