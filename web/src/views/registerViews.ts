import { MAILBOX_CLIENT_COMPONENT, MAILBOX_CLIENT_VIEW_TYPE, MailboxClient } from "./mailbox/MailboxClient.js";
import { createViewRegistry, registerViewRenderer, type ViewRegistry } from "./viewRegistry.js";

/**
 * Every view renderer this client knows, registered under both the backend's opaque
 * `clientComponent` id and the view type itself (see resolveViewRenderer for why both).
 */
export function createDefaultViewRegistry(): ViewRegistry {
  const registry = createViewRegistry();
  registerViewRenderer(registry, MAILBOX_CLIENT_COMPONENT, MailboxClient);
  registerViewRenderer(registry, MAILBOX_CLIENT_VIEW_TYPE, MailboxClient);
  return registry;
}
