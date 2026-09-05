# Semprec web frontend

React + TypeScript, built with Vite; unit tests run on Vitest with Testing Library
and jsdom. Package manager is pnpm, pinned the same way as `backend/`.

```
pnpm install
pnpm dev        # Vite dev server
pnpm test       # Vitest
pnpm typecheck  # tsc --noEmit
pnpm build      # typecheck + production build into dist/
```

`VITE_API_BASE_URL` points the client at the backend's generic operation endpoints
(default `/api`); the view to open comes from the `?view=<viewId>` query parameter.

## Structure

- `src/api/` — the generic operations port (`GenericOperations`) plus its HTTP binding.
  Every view reads through this port and nothing else: no view gets a private read path
  into a module's own tables, and all writes go through the backend choke point. Alongside
  the generic reads/writes it carries `callOperation`, which invokes a module's *declared*
  named operation (`email.send`, …) — the same surface an agent calls, for the actions no
  generic call can express.
- `src/views/` — the client half of the backend's view-type registry: `viewRegistry.ts`
  maps a registered view type's `clientComponent` id to the component that renders it,
  and `ViewHost` loads a view and hands it to whichever renderer resolves.
- `src/views/mailbox/` — the `mailbox-client` renderer (issue #96): folder sidebar with
  unread counts, message list, reading pane; three panes on a wide layout, one pane at a
  time with an explicit back action on a narrow one. Triage (issue #97) lives alongside it:
  `triage.ts` holds the actions (read/flag as an item update, archive/delete as a relation
  move) and `keyboard.ts` the `j`/`k`/`e` shortcuts, which go silent inside an editable
  control. Row buttons, the bulk toolbar over the selected messages and the keyboard all
  call the same actions. Compose (issue #98) is `compose.ts` (reply/reply-all recipients from
  the stored envelope, the From fallback order, the draft/send payloads), `ComposeWindow.tsx`
  (the floating minimizable window and the inline reply, sharing one form) and
  `mailOperations.ts` (`email.message.envelope`, `email.draft.create`, `email.send`). Compose
  state lives in `MailboxClient`, so minimizing, navigating the reading pane or a rejected
  send never loses what was typed.
- `src/i18n/` — message catalogs (Czech primary, English fallback) and the `useTranslate`
  hook. No user-facing string is written inline in a component.
- `src/styles/tokens.css` — the design tokens every component styles itself through,
  including the light/dark palettes and the single-pane breakpoint.
- `src/components/StateViews.tsx` — the shared loading / empty / error states. An error
  is either `retryable` (offers "try again") or `unavailable` (does not).
