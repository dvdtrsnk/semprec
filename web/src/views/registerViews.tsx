import { MAILBOX_CLIENT_COMPONENT, MAILBOX_CLIENT_VIEW_TYPE, MailboxClient } from "./mailbox/MailboxClient.js";
import { JOURNAL_INBOX_LIST_COMPONENT, JOURNAL_INBOX_VIEW_TYPE, JournalInboxList } from "./journal/JournalInboxList.js";
import type { MailDraftOperations } from "../api/mailDraftOperations.js";
import { createViewRegistry, registerViewRenderer, type ViewRegistry, type ViewRendererProps } from "./viewRegistry.js";

/** The route-family adapters a renderer needs beyond the generic operations every renderer receives. */
export interface ViewRendererDependencies {
  mailDrafts: MailDraftOperations;
}

/**
 * Every view renderer this client knows, registered under both the backend's opaque
 * `clientComponent` id and the view type itself (see resolveViewRenderer for why both). A
 * renderer that needs a route-family adapter gets it bound here, so every renderer is still
 * rendered with `{ view, operations }` alone.
 */
export function createDefaultViewRegistry(dependencies: ViewRendererDependencies): ViewRegistry {
  const registry = createViewRegistry();
  const Mailbox = (props: ViewRendererProps) => <MailboxClient {...props} mailDrafts={dependencies.mailDrafts} />;
  registerViewRenderer(registry, MAILBOX_CLIENT_COMPONENT, Mailbox);
  registerViewRenderer(registry, MAILBOX_CLIENT_VIEW_TYPE, Mailbox);
  registerViewRenderer(registry, JOURNAL_INBOX_LIST_COMPONENT, JournalInboxList);
  registerViewRenderer(registry, JOURNAL_INBOX_VIEW_TYPE, JournalInboxList);
  return registry;
}
