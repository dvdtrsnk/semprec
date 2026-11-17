# Native session bridge (issue #141)

The embedded editor is the same web app (`web/`) that also runs standalone in a
browser. When the native iOS/macOS shell opens it inside a `WKWebView`, the
editor must reuse the session the user already established natively — it has
no login screen or `/api/auth/login` call of its own inside that webview.

The canonical contract (handler name, request/reply shape) lives in
`backend/packages/data/src/auth/nativeBridge.ts` as
`NATIVE_SESSION_BRIDGE_HANDLER_NAME` and `NativeSessionBridgeReply`; this file
describes how the native side must implement it. The web app does not depend
on that package (no shared build target yet), so treat the TypeScript there
as the source of truth for names and shapes and keep the Swift side in sync
by hand.

## Native side (Swift, not yet implemented)

1. After a successful native login (`POST /api/auth/login` with
   `platform: "ios"` or `"macos"`), store the returned `token` in the
   Keychain. Never write it anywhere else (no `UserDefaults`, no disk file).
2. When presenting the embedded editor, configure the `WKWebView`'s
   `WKUserContentController` with a `WKScriptMessageHandlerWithReply`
   registered under the name `semprecNativeSession`
   (`NATIVE_SESSION_BRIDGE_HANDLER_NAME`) — and only on that web view, never
   on a general-purpose in-app browser.
3. On receiving a message, look up the token currently in the Keychain and
   reply with:
   ```json
   { "token": "<opaque token>", "platform": "ios", "user": { "...": "..." } }
   ```
   (`platform` matches whichever of `ios`/`macos` this build is; `user` is
   the same public user shape `/api/auth/login` returns.) Do not inject the
   token any other way — no query string, no `WKUserScript`-set global, no
   `localStorage` seeding — the reply is the only path the token takes onto
   the page.
4. If no session exists in the Keychain (logged out, revoked, expired), the
   shell must not open the embedded editor at all; it has nothing to bridge.

## Web side (`web/`, not yet implemented)

1. On startup, detect the bridge before attempting any login flow:
   `typeof window.webkit?.messageHandlers?.semprecNativeSession !== "undefined"`.
2. If present, request the session once via
   `await window.webkit.messageHandlers.semprecNativeSession.postMessage({})`
   and use the returned `token` as `Authorization: Bearer` on every API call
   for the life of the page, exactly as a native client would
   (`SESSION_DELIVERY_CHANNEL_BY_PLATFORM` requires Bearer for `ios`/`macos`).
   Do not store the token (no `localStorage`/`sessionStorage`) — the native
   host owns it; ask the bridge again on the next page load.
3. If the bridge is present, skip the normal login screen entirely and never
   call `/api/auth/login` — a bridge reply failure means the shell shouldn't
   have opened the editor in the first place (see step 4 above), not
   something the web app recovers from by falling back to its own login.
