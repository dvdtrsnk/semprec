# Handover: throttle the Graph mail webhook per client address and look each subscription up once per batch

Commit on `fix/followup-mail-edges`: `040d6eeff`. Nothing was run against a real server.

**Root cause.** `createGraphWebhookRequestListener` had no throttle and ran `handleGraphChangeNotification` (a `route_graph_subscription` lookup plus a tenant transaction) for every entry of a batch, unbounded and without dedupe.

**Changes.**
- `clientIpThrottle.ts`: `mailWebhook` (300 per minute per client address, its own budget).
- `graphNotificationBatch.ts`: `distinctGraphNotifications` moved out of `calendarWebhookHandlers.ts` unchanged (first 100 entries, distinct `(subscriptionId, clientState)` pairs, at most 20, 256-character bounds); both Graph receivers use it.
- `graphWebhookHandler.ts`: takes `{ trustProxy, clientIpThrottle? }`; every POST, the handshake included, is counted first and refused with an empty 429 and `Retry-After`; the batch goes through `distinctGraphNotifications`. `app.ts` passes `trustProxy`.
- `docs/architecture/tenancy-and-security.md`: public throttles.

**Tests.**
- `__tests__/graphWebhookHandler.test.ts`: "looks a repeated subscription up once per batch and at most 20 distinct subscriptions" (90 lookups before the fix) and "answers an empty 429 with Retry-After before any database read once an address is over its budget, the handshake included" (500 before the fix).
- `__tests__/clientIpThrottle.unit.test.ts`: the limits table.

**Left.** Nothing. The mail handshake's unbounded `validationToken` echo without `X-Content-Type-Options: nosniff` was recorded here and is fixed by sp-0a0980c4-523e-4164-807a-f0819ca0d476 (`4f0f7b529`).
