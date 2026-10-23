import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useTranslate, type MessageKey } from "../../i18n/index.js";
import type { ViewRendererProps } from "../viewRegistry.js";
import { useAsyncResource } from "../mailbox/useAsyncResource.js";
import {
  journalInboxItemListSchema,
  parseJournalInboxConfig,
  type JournalInboxItemSummary,
} from "./journalInboxConfig.js";

/** The backend's opaque `clientComponent` id for this view type (see journalInboxViewType.ts). */
export const JOURNAL_INBOX_LIST_COMPONENT = "journalInboxList";
/** Mirrors the backend's `JOURNAL_INBOX_VIEW_TYPE` (journalInboxViewType.ts) — kept as a literal here since the two packages don't share types. */
export const JOURNAL_INBOX_VIEW_TYPE = "journal-inbox";

export type { JournalInboxItemSummary };

const STATUS_KEYS: Record<string, MessageKey> = {
  needsClarification: "journal.inbox.status.needsClarification",
  proposed: "journal.inbox.status.proposed",
  confirmed: "journal.inbox.status.confirmed",
  rejected: "journal.inbox.status.rejected",
  invalid: "journal.inbox.status.invalid",
};

function statusLabelKey(status: string | null): MessageKey {
  return (status && STATUS_KEYS[status]) || "journal.inbox.status.none";
}

/**
 * Journal's Inbox-list view renderer (issue #106): renders a Journal day's cached, related
 * Inbox items as an ordinary list, reading the pre-computed array straight off the day
 * item's `computed[computedKey]` — no live filter query, since caching that derived state
 * is the entire point of `inbox/journalInboxCompute.ts`. Every label shown is resolved
 * through i18n; the cached payload itself carries only canonical English keys/values.
 */
export function JournalInboxList({ view, operations }: ViewRendererProps) {
  const t = useTranslate();
  const config = parseJournalInboxConfig(view.config);

  // The backend's `Item.computed` is typed `z.record(..., z.unknown())` (api/genericOperations.ts) —
  // nothing upstream of this validates its shape, so a parse failure here (a schema drift, or a
  // malformed cached payload) surfaces as the same error state a failed fetch would, rather than
  // rendering garbage or throwing inside the .map() below.
  const { resource, reload } = useAsyncResource(async () => {
    if (!config || !view.databaseId) return [];
    const day = await operations.getItem(view.databaseId, config.journalDayItemId);
    return journalInboxItemListSchema.parse(day?.computed[config.computedKey] ?? []);
  }, [view.databaseId, config?.journalDayItemId, config?.computedKey]);

  if (!config || !view.databaseId) return <EmptyState message={t("journal.inbox.unconfigured")} />;
  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;

  const items = resource.value;
  if (items.length === 0) return <EmptyState message={t("journal.inbox.empty")} />;

  return (
    <ul className="journal-inbox-list">
      {items.map((item) => (
        <li key={item.id} className="journal-inbox-list__item">
          <span className="journal-inbox-list__time">{item.time ?? ""}</span>
          {item.type ? (
            <span className="journal-inbox-list__type" title={item.type.name}>
              {item.type.emoji}
            </span>
          ) : null}
          <span className="journal-inbox-list__text">{item.text ?? ""}</span>
          <span className="journal-inbox-list__status">{t(statusLabelKey(item.status))}</span>
        </li>
      ))}
    </ul>
  );
}
