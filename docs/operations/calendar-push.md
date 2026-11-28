# Calendar push notifications

Internet account calendars sync every 5 minutes (`calendarAccountSyncSweep`) and when the app asks
(`POST /api/accounts/:id/calendars/sync`, on foreground). Google and Microsoft accounts can also
tell the server about a change within seconds, through push channels the API queue creates, renews
and stops (`calendarPushChannels`, hourly sweep `calendarPushChannelsSweep`). CalDAV accounts
(iCloud, generic) have no push and rely on the sweep and the app's trigger.

## Configuration

Read by the API process (`resolveCalendarPushRuntime` in `services/alldots-api`) when its queue
starts:

| Provider  | Channels are kept when                                                                                                                       | Webhook                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Google    | `GMAIL_OAUTH_CLIENT_ID`/`_SECRET` are set, `APP_BASE_URL` is an `https://` origin without a path, and `GOOGLE_CALENDAR_WEBHOOK_ENABLED=true` | `<APP_BASE_URL>/api/calendar/google/webhook` |
| Microsoft | `MS_GRAPH_OAUTH_CLIENT_ID`/`_SECRET` are set and `APP_BASE_URL` is an `https://` origin without a path                                       | `<APP_BASE_URL>/api/calendar/graph/webhook`  |

- Google's `events.watch` accepts only an HTTPS address with a valid certificate on a domain
  verified for the Google Cloud project of the OAuth client. Set
  `GOOGLE_CALENDAR_WEBHOOK_ENABLED=true` only after verifying the domain: Google refuses every
  watch on an unverified one.
- Microsoft Graph calls the webhook with a `validationToken` while it creates a subscription and
  must get it back within 10 seconds, so the URL must be reachable from the internet before the
  first sweep.
- With the OAuth client set but the webhook not hosted, the next maintenance stops the existing
  channels of that provider and creates none. Without the OAuth client the rows are only forgotten;
  the provider ends the channels at their expiry (Google at most 7 days, Graph about 3).

## Behaviour to expect

- New channels appear within an hour of an account's first successful calendar sync (the hourly
  sweep). A channel within a day of its expiry is replaced (Google) or extended (Graph).
- A notification only queues a sync pass of the account; the pass fetches the changes.
- Logs: "Calendar push channels maintained" (counts per account), "Calendar push channel step
  failed" (account id, provider, step, error name), "Google Calendar webhook notification
  rejected" and "Graph calendar webhook notification rejected" (outcome only). A failed step fails the job,
  which the queue retries up to three times; the next sweep tries again.
- `calendar_push_channels` holds the channel secrets and is not part of the tenant export.
