# Decision: approve throttling the Graph mail webhook per client address and looking each subscription up once per batch

- Question: May the proposal (sp-8acebdc7-a9eb-4f52-8d7a-7b47f95680fc) be approved as specified against the branch tip?
- Owner instruction (David, 2026-11-22): fix the findings of the end-to-end test campaign after PR #2089 on sibling branches, one repository issue per finding under the internet-accounts epic; `POST /api/mail/graph/webhook` has no per-IP rate limit and does one router lookup per notification; apply the throttle of the calendar webhooks and the mail OAuth callback before any database read, and dedupe and cap the lookups per batch, with tests.
- Options considered: sharing the `calendarWebhook` budget (rejected: Graph delivers mail and calendar notifications from the same addresses, so a calendar burst would starve mail); a second copy of the batch parsing (rejected: one shared function keeps both Graph receivers on the same bounds).
- Decision: approve the specification as written.
- Exact spec change: none.
- Actor: claude-delegated-by-david
- Model: claude-opus-5-5
- Date: 2026-11-22
