import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useTranslate } from "../../i18n/index.js";
import type { GenericOperations, Item } from "../../api/genericOperations.js";
import type { ViewRendererProps } from "../viewRegistry.js";
import { folderFilter, foldersFilter, messageSort, parseMailboxConfig, unreadFilter, type MailboxConfig } from "./config.js";
import { useAsyncResource } from "./useAsyncResource.js";
import { activePane, backTarget, useIsNarrow, type Pane } from "./usePaneLayout.js";
import "./mailbox.css";

/** The property keys the mailbox reads off a generic item; all of them are plain scalars. */
function text(item: Item, key: string): string | null {
  const value = item.properties[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isTrue(item: Item, key: string): boolean {
  return item.properties[key] === true;
}

const FOLDER_ORDER = ["inbox", "drafts", "sent", "archive", "junk", "trash"];

/** Inbox first, then the other well-known purposes, then everything else by name. */
function sortFolders(folders: Item[]): Item[] {
  return [...folders].sort((a, b) => {
    const rank = (item: Item) => {
      const purpose = text(item, "specialPurpose");
      const index = purpose ? FOLDER_ORDER.indexOf(purpose) : -1;
      return index === -1 ? FOLDER_ORDER.length : index;
    };
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return (text(a, "name") ?? "").localeCompare(text(b, "name") ?? "");
  });
}

interface MailboxData {
  folders: Item[];
  unreadCounts: Record<string, number>;
}

function FolderList({
  folders,
  unreadCounts,
  selectedFolderId,
  onSelect,
}: {
  folders: Item[];
  unreadCounts: Record<string, number>;
  selectedFolderId: string | null;
  onSelect: (folderId: string) => void;
}) {
  const t = useTranslate();
  if (folders.length === 0) return <EmptyState message={t("mailbox.folders.empty")} />;

  return (
    <ul className="folder-list">
      {folders.map((folder) => {
        const unread = unreadCounts[folder.id] ?? 0;
        return (
          <li key={folder.id}>
            <button
              type="button"
              className="folder-list__item"
              aria-current={folder.id === selectedFolderId ? "true" : undefined}
              onClick={() => onSelect(folder.id)}
            >
              <span className="folder-list__name">{text(folder, "name") ?? folder.id}</span>
              {unread > 0 ? (
                <span className="folder-list__unread" aria-label={t("mailbox.unreadCount", { count: unread })}>
                  {unread}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MessageList({
  config,
  operations,
  databaseId,
  folderId,
  selectedMessageId,
  onSelect,
}: {
  config: MailboxConfig;
  operations: GenericOperations;
  databaseId: string;
  folderId: string;
  selectedMessageId: string | null;
  onSelect: (messageId: string) => void;
}) {
  const t = useTranslate();
  const { resource, reload } = useAsyncResource(
    () => operations.listItems(databaseId, { filter: folderFilter(config, folderId), sort: messageSort(config), limit: 50 }),
    [databaseId, folderId, config],
  );

  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;
  if (resource.value.items.length === 0) return <EmptyState message={t("mailbox.messages.empty")} />;

  return (
    <ul className="message-list">
      {resource.value.items.map((message) => {
        const unread = !isTrue(message, config.readPropertyKey);
        return (
          <li key={message.id}>
            <button
              type="button"
              className={`message-list__item${unread ? " message-list__item--unread" : ""}`}
              aria-current={message.id === selectedMessageId ? "true" : undefined}
              onClick={() => onSelect(message.id)}
            >
              <span className="message-list__sender">{text(message, "sender") ?? ""}</span>
              <span className="message-list__subject">{text(message, "name") ?? t("mailbox.message.noSubject")}</span>
              {unread ? <span className="message-list__unread-dot" aria-label={t("mailbox.message.unread")} /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ReadingPane({ operations, databaseId, messageId }: { operations: GenericOperations; databaseId: string; messageId: string | null }) {
  const t = useTranslate();
  const { resource, reload } = useAsyncResource(
    () => (messageId ? operations.getItem(databaseId, messageId) : Promise.resolve(null)),
    [databaseId, messageId],
  );

  if (!messageId) return <EmptyState message={t("mailbox.message.none")} />;
  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;

  const message = resource.value;
  if (!message) return <EmptyState message={t("mailbox.message.none")} />;

  return (
    <article className="reading-pane">
      <h3 className="reading-pane__subject">{text(message, "name") ?? t("mailbox.message.noSubject")}</h3>
      <dl className="reading-pane__envelope">
        <dt>{t("mailbox.message.from")}</dt>
        <dd>{text(message, "sender") ?? ""}</dd>
        <dt>{t("mailbox.message.to")}</dt>
        <dd>{text(message, "recipients") ?? ""}</dd>
      </dl>
      {/* Rendered as text, never as markup: the stored body is untrusted remote content. */}
      <p className="reading-pane__body">{text(message, "body") ?? ""}</p>
    </article>
  );
}

function MailboxPanes({ config, operations, databaseId }: { config: MailboxConfig; operations: GenericOperations; databaseId: string }) {
  const t = useTranslate();
  const isNarrow = useIsNarrow();
  const [folderId, setFolderId] = useState<string | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [didAutoSelect, setDidAutoSelect] = useState(false);

  const { resource, reload } = useAsyncResource<MailboxData>(async () => {
    const page = await operations.listItems(config.foldersDatabaseId, { filter: foldersFilter(config), limit: 200 });
    const folders = sortFolders(page.items);
    // Unread counts are the same generic count operation, once per folder — the sidebar
    // never asks for a mailbox-specific aggregate endpoint.
    const counts = await Promise.all(folders.map((folder) => operations.countItems(databaseId, { filter: unreadFilter(config, folder.id) })));
    const unreadCounts: Record<string, number> = {};
    folders.forEach((folder, index) => {
      unreadCounts[folder.id] = counts[index] ?? 0;
    });
    return { folders, unreadCounts };
  }, [config, databaseId]);

  const folders = resource.status === "ready" ? resource.value.folders : [];

  useEffect(() => {
    // Open on the Inbox once, on first load. Only once: after an explicit back out of a
    // folder, re-selecting it here would make the back action look like it did nothing.
    if (didAutoSelect || folders.length === 0) return;
    const inbox = folders.find((folder) => folder.properties.specialPurpose === "inbox") ?? folders[0];
    if (inbox) setFolderId(inbox.id);
    setDidAutoSelect(true);
  }, [folders, didAutoSelect]);

  const selectFolder = useCallback((nextFolderId: string) => {
    setFolderId(nextFolderId);
    setMessageId(null);
  }, []);

  const pane: Pane = activePane({ folderId, messageId });
  const back = backTarget(pane);
  const goBack = useCallback(() => {
    if (back === "messages") setMessageId(null);
    else if (back === "folders") setFolderId(null);
  }, [back]);

  const visible = useMemo(
    () => ({
      folders: !isNarrow || pane === "folders",
      messages: !isNarrow || pane === "messages",
      message: !isNarrow || pane === "message",
    }),
    [isNarrow, pane],
  );

  return (
    <div className="mailbox" data-layout={isNarrow ? "single-pane" : "three-pane"} data-pane={pane}>
      {isNarrow && back ? (
        <button type="button" className="mailbox__back button" onClick={goBack}>
          {t("mailbox.back")}
        </button>
      ) : null}

      {visible.folders ? (
        <section className="mailbox__pane mailbox__pane--folders" aria-label={t("mailbox.folders")}>
          <h2 className="mailbox__pane-title">{t("mailbox.folders")}</h2>
          {resource.status === "loading" ? <LoadingState /> : null}
          {resource.status === "failed" ? <ErrorState error={resource.error} onRetry={reload} /> : null}
          {resource.status === "ready" ? (
            <FolderList
              folders={resource.value.folders}
              unreadCounts={resource.value.unreadCounts}
              selectedFolderId={folderId}
              onSelect={selectFolder}
            />
          ) : null}
        </section>
      ) : null}

      {visible.messages ? (
        <section className="mailbox__pane mailbox__pane--messages" aria-label={t("mailbox.messages")}>
          <h2 className="mailbox__pane-title">{t("mailbox.messages")}</h2>
          {folderId ? (
            <MessageList
              config={config}
              operations={operations}
              databaseId={databaseId}
              folderId={folderId}
              selectedMessageId={messageId}
              onSelect={setMessageId}
            />
          ) : (
            <EmptyState message={t("mailbox.messages.empty")} />
          )}
        </section>
      ) : null}

      {visible.message ? (
        <section className="mailbox__pane mailbox__pane--message" aria-label={t("mailbox.message")}>
          <h2 className="mailbox__pane-title">{t("mailbox.message")}</h2>
          <ReadingPane operations={operations} databaseId={databaseId} messageId={messageId} />
        </section>
      ) : null}
    </div>
  );
}

/**
 * The renderer the `mailbox-client` view type resolves to: folder sidebar, message list and
 * reading pane, three panes side by side on a wide layout and one at a time with an explicit
 * back action on a narrow one. Everything it reads goes through the generic operations —
 * folders and messages are ordinary items, folder membership is the Emails-to-Folders
 * relation, unread counts are a generic filtered count.
 */
export function MailboxClient({ view, operations }: ViewRendererProps) {
  const t = useTranslate();
  const config = useMemo(() => parseMailboxConfig(view.config), [view.config]);

  if (!config || !view.databaseId) {
    return (
      <div className="mailbox mailbox--unconfigured">
        <EmptyState message={t("mailbox.unconfigured")} />
      </div>
    );
  }
  return <MailboxPanes config={config} operations={operations} databaseId={view.databaseId} />;
}

export const MAILBOX_CLIENT_COMPONENT = "mailboxClient";
export const MAILBOX_CLIENT_VIEW_TYPE = "mailbox-client";
