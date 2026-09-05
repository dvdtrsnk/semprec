import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useTranslate } from "../../i18n/index.js";
import type { GenericOperations, Item } from "../../api/genericOperations.js";
import type { ViewRendererProps } from "../viewRegistry.js";
import {
  ARCHIVE_FOLDER_PURPOSE,
  TRASH_FOLDER_PURPOSE,
  folderByPurpose,
  folderFilter,
  foldersFilter,
  messageSort,
  parseMailboxConfig,
  unreadFilter,
  type MailboxConfig,
} from "./config.js";
import { resolveShortcut } from "./keyboard.js";
import { moveMessages, movedCursor, nextCursorAfterRemoval, setMessageFlag, type TriageResult } from "./triage.js";
import { useAsyncResource } from "./useAsyncResource.js";
import { activePane, backTarget, useIsNarrow, type Pane } from "./usePaneLayout.js";
import "./mailbox.css";

/** The property keys the mailbox reads off a generic item; all of them are plain scalars. */
function text(item: Item, key: string): string | null {
  const value = item.properties[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A legacy message that predates the flag properties simply has neither — which reads as false. */
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

/**
 * One triage action, in the shape both the row buttons, the bulk toolbar and the keyboard
 * shortcuts hand to `runTriage` — the three input paths differ only in which messages they
 * name, never in what an action does.
 */
type TriageAction = { kind: "flag"; propertyKey: string; value: boolean } | { kind: "move"; toFolderId: string };

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

/** The archive/delete destinations available from the folder currently being read. */
interface MoveTargets {
  archiveFolderId: string | null;
  trashFolderId: string | null;
}

function MessageRow({
  message,
  config,
  targets,
  isOpen,
  isCursor,
  isSelected,
  onOpen,
  onToggleSelected,
  onTriage,
  registerRef,
}: {
  message: Item;
  config: MailboxConfig;
  targets: MoveTargets;
  isOpen: boolean;
  isCursor: boolean;
  isSelected: boolean;
  onOpen: () => void;
  onToggleSelected: () => void;
  onTriage: (messageIds: string[], action: TriageAction) => void;
  registerRef: (element: HTMLButtonElement | null) => void;
}) {
  const t = useTranslate();
  const subjectId = useId();
  const { archiveFolderId, trashFolderId } = targets;
  const read = isTrue(message, config.readPropertyKey);
  const flagged = isTrue(message, config.flaggedPropertyKey);

  // Every row action names the row it belongs to through `aria-describedby` rather than
  // through its own label: the label stays the plain verb ("Archive"), and the message's
  // subject is announced alongside it.
  const action = (label: string, onClick: () => void) => (
    <button type="button" className="button message-list__action" aria-describedby={subjectId} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <li className="message-list__row" data-cursor={isCursor ? "true" : undefined}>
      <input
        type="checkbox"
        className="message-list__select"
        checked={isSelected}
        onChange={onToggleSelected}
        aria-label={t("mailbox.message.select")}
        aria-describedby={subjectId}
      />
      <button
        type="button"
        className={`message-list__item${read ? "" : " message-list__item--unread"}`}
        aria-current={isOpen ? "true" : undefined}
        onClick={onOpen}
        ref={registerRef}
      >
        <span className="message-list__sender">{text(message, "sender") ?? ""}</span>
        <span className="message-list__subject" id={subjectId}>
          {text(message, "name") ?? t("mailbox.message.noSubject")}
        </span>
        {read ? null : <span className="message-list__unread-dot" aria-label={t("mailbox.message.unread")} />}
        {flagged ? (
          <span className="message-list__flag" aria-label={t("mailbox.message.flagged")}>
            ★
          </span>
        ) : null}
      </button>
      <span className="message-list__actions">
        {archiveFolderId ? action(t("mailbox.actions.archive"), () => onTriage([message.id], { kind: "move", toFolderId: archiveFolderId })) : null}
        {trashFolderId ? action(t("mailbox.actions.delete"), () => onTriage([message.id], { kind: "move", toFolderId: trashFolderId })) : null}
        {action(t(read ? "mailbox.actions.markUnread" : "mailbox.actions.markRead"), () =>
          onTriage([message.id], { kind: "flag", propertyKey: config.readPropertyKey, value: !read }),
        )}
        {action(t(flagged ? "mailbox.actions.unflag" : "mailbox.actions.flag"), () =>
          onTriage([message.id], { kind: "flag", propertyKey: config.flaggedPropertyKey, value: !flagged }),
        )}
      </span>
    </li>
  );
}

/**
 * The bulk counterpart of the row actions: the same operations, applied to exactly the
 * selected messages. Read and flag state get an explicit set-to-true and set-to-false button
 * rather than a toggle, since a selection can hold both states at once.
 */
function SelectionToolbar({
  config,
  targets,
  selectedIds,
  onTriage,
  onClear,
}: {
  config: MailboxConfig;
  targets: MoveTargets;
  selectedIds: readonly string[];
  onTriage: (messageIds: string[], action: TriageAction) => void;
  onClear: () => void;
}) {
  const t = useTranslate();
  const { archiveFolderId, trashFolderId } = targets;
  const ids = [...selectedIds];
  const action = (label: string, run: () => void) => (
    <button type="button" className="button" onClick={run}>
      {label}
    </button>
  );

  return (
    <div className="selection-toolbar" role="toolbar" aria-label={t("mailbox.selection")}>
      <span className="selection-toolbar__count" role="status">
        {t("mailbox.selection.count", { count: selectedIds.length })}
      </span>
      {archiveFolderId ? action(t("mailbox.actions.archive"), () => onTriage(ids, { kind: "move", toFolderId: archiveFolderId })) : null}
      {trashFolderId ? action(t("mailbox.actions.delete"), () => onTriage(ids, { kind: "move", toFolderId: trashFolderId })) : null}
      {action(t("mailbox.actions.markRead"), () => onTriage(ids, { kind: "flag", propertyKey: config.readPropertyKey, value: true }))}
      {action(t("mailbox.actions.markUnread"), () => onTriage(ids, { kind: "flag", propertyKey: config.readPropertyKey, value: false }))}
      {action(t("mailbox.actions.flag"), () => onTriage(ids, { kind: "flag", propertyKey: config.flaggedPropertyKey, value: true }))}
      {action(t("mailbox.actions.unflag"), () => onTriage(ids, { kind: "flag", propertyKey: config.flaggedPropertyKey, value: false }))}
      {action(t("mailbox.selection.clear"), onClear)}
    </div>
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

/** How many of the given messages currently count as unread — the sidebar's per-folder delta. */
function countUnread(messages: readonly Item[], messageIds: readonly string[], readPropertyKey: string): number {
  const ids = new Set(messageIds);
  return messages.filter((message) => ids.has(message.id) && !isTrue(message, readPropertyKey)).length;
}

/** The ready message list: its toolbar, its partial-failure report, and the rows themselves. */
function MessagesPane({
  config,
  targets,
  messages,
  selectedIds,
  cursorId,
  openMessageId,
  failure,
  onOpen,
  onToggleSelected,
  onClearSelection,
  onTriage,
  rowRefs,
}: {
  config: MailboxConfig;
  targets: MoveTargets;
  messages: readonly Item[];
  selectedIds: readonly string[];
  cursorId: string | null;
  openMessageId: string | null;
  failure: { failed: number; total: number } | null;
  onOpen: (messageId: string) => void;
  onToggleSelected: (messageId: string) => void;
  onClearSelection: () => void;
  onTriage: (messageIds: string[], action: TriageAction) => void;
  rowRefs: RefObject<Map<string, HTMLButtonElement>>;
}) {
  const t = useTranslate();

  return (
    <>
      {selectedIds.length > 0 ? (
        <SelectionToolbar config={config} targets={targets} selectedIds={selectedIds} onTriage={onTriage} onClear={onClearSelection} />
      ) : null}
      {failure ? (
        <p className="message-list__failure" role="alert">
          {t("mailbox.triage.failed", { failed: failure.failed, total: failure.total })}
        </p>
      ) : null}
      {messages.length === 0 ? (
        <EmptyState message={t("mailbox.messages.empty")} />
      ) : (
        <ul className="message-list">
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              config={config}
              targets={targets}
              isOpen={message.id === openMessageId}
              isCursor={message.id === cursorId}
              isSelected={selectedIds.includes(message.id)}
              onOpen={() => onOpen(message.id)}
              onToggleSelected={() => onToggleSelected(message.id)}
              onTriage={onTriage}
              registerRef={(element) => {
                if (element) rowRefs.current.set(message.id, element);
                else rowRefs.current.delete(message.id);
              }}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function MailboxPanes({ config, operations, databaseId }: { config: MailboxConfig; operations: GenericOperations; databaseId: string }) {
  const t = useTranslate();
  const isNarrow = useIsNarrow();
  const [folderId, setFolderId] = useState<string | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [didAutoSelect, setDidAutoSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ failed: number; total: number } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

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

  const messagesResource = useAsyncResource<Item[]>(
    async () => {
      if (!folderId) return [];
      const page = await operations.listItems(databaseId, { filter: folderFilter(config, folderId), sort: messageSort(config), limit: 50 });
      return page.items;
    },
    [databaseId, folderId, config],
  );

  // A completed triage is applied to what is already on screen rather than re-read: a
  // refetch would unmount the rows mid-action and drop the keyboard cursor's focus with
  // them. Both overlays sit on top of their read and are dropped the moment that read
  // resolves again (a retry, another folder), so a fresh answer always wins.
  const [triagedMessages, setTriagedMessages] = useState<Item[] | null>(null);
  const [unreadDeltas, setUnreadDeltas] = useState<Record<string, number>>({});
  useEffect(() => setTriagedMessages(null), [messagesResource.resource]);
  useEffect(() => setUnreadDeltas({}), [resource]);

  const messages = triagedMessages ?? (messagesResource.resource.status === "ready" ? messagesResource.resource.value : []);
  const unreadCounts = useMemo(() => {
    const base = resource.status === "ready" ? resource.value.unreadCounts : {};
    const entries = Object.entries(unreadDeltas);
    if (entries.length === 0) return base;
    const merged = { ...base };
    for (const [id, delta] of entries) merged[id] = Math.max((merged[id] ?? 0) + delta, 0);
    return merged;
  }, [resource, unreadDeltas]);

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
    // Selection and cursor belong to the list being triaged; carrying them into another
    // folder would leave the toolbar acting on messages that are no longer on screen.
    setSelectedIds([]);
    setCursorId(null);
    setFailure(null);
  }, []);

  // Archive and delete only offer themselves where they mean something: a folder cannot be
  // its own move destination, and a mailbox without an Archive/Trash folder gets no such action.
  const targets = useMemo<MoveTargets>(() => {
    const archive = folderByPurpose(folders, ARCHIVE_FOLDER_PURPOSE);
    const trash = folderByPurpose(folders, TRASH_FOLDER_PURPOSE);
    return {
      archiveFolderId: archive && archive.id !== folderId ? archive.id : null,
      trashFolderId: trash && trash.id !== folderId ? trash.id : null,
    };
  }, [folders, folderId]);

  const runTriage = useCallback(
    async (messageIds: string[], action: TriageAction) => {
      if (messageIds.length === 0 || !folderId) return;

      const result: TriageResult =
        action.kind === "flag"
          ? await setMessageFlag(operations, { databaseId, propertyKey: action.propertyKey, value: action.value }, messageIds)
          : await moveMessages(operations, { databaseId, relationKey: config.folderRelationKey, fromFolderId: folderId, toFolderId: action.toFolderId }, messageIds);

      const succeeded = new Set(result.succeeded);
      const unreadMoved = countUnread(messages, result.succeeded, config.readPropertyKey);

      const addUnreadDelta = (deltas: Record<string, number>) =>
        setUnreadDeltas((current) => {
          const merged = { ...current };
          for (const [id, delta] of Object.entries(deltas)) merged[id] = (merged[id] ?? 0) + delta;
          return merged;
        });

      if (action.kind === "move") {
        setCursorId((current) => nextCursorAfterRemoval(messages.map((message) => message.id), current, result.succeeded));
        setTriagedMessages(messages.filter((message) => !succeeded.has(message.id)));
        setMessageId((current) => (current && succeeded.has(current) ? null : current));
        addUnreadDelta({ [folderId]: -unreadMoved, [action.toFolderId]: unreadMoved });
      } else {
        setTriagedMessages(
          messages.map((message) =>
            succeeded.has(message.id) ? { ...message, properties: { ...message.properties, [action.propertyKey]: action.value } } : message,
          ),
        );
        if (action.propertyKey === config.readPropertyKey) {
          // Marking read clears exactly the messages that were unread; marking unread adds
          // back exactly the ones that were read.
          addUnreadDelta({ [folderId]: action.value ? -unreadMoved : result.succeeded.length - unreadMoved });
        }
      }

      // Only the messages that failed stay selected, so a retry repeats exactly the
      // unfinished work rather than redoing what already went through.
      setSelectedIds((current) => current.filter((id) => !succeeded.has(id)));
      setFailure(result.failed.length > 0 ? { failed: result.failed.length, total: messageIds.length } : null);
    },
    [operations, databaseId, config, folderId, messages],
  );

  const orderedIds = useMemo(() => messages.map((message) => message.id), [messages]);

  // What a shortcut acts on: the selection when there is one, otherwise the message under the
  // cursor — never anything the user has not pointed at one way or the other.
  const keyboardTargets = useCallback(() => (selectedIds.length > 0 ? [...selectedIds] : cursorId ? [cursorId] : []), [selectedIds, cursorId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = resolveShortcut(event);
      if (!shortcut) return;
      if (shortcut === "archive") {
        const archiveFolderId = targets.archiveFolderId;
        const messageIds = keyboardTargets();
        if (!archiveFolderId || messageIds.length === 0) return;
        event.preventDefault();
        void runTriage(messageIds, { kind: "move", toFolderId: archiveFolderId });
        return;
      }
      if (orderedIds.length === 0) return;
      event.preventDefault();
      setCursorId((current) => movedCursor(orderedIds, current, shortcut === "cursorNext" ? 1 : -1));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [orderedIds, keyboardTargets, runTriage, targets.archiveFolderId]);

  // The cursor is a real focus position, not just a highlight: moving it moves the browser's
  // focus onto that row, so Enter opens the message and assistive tech follows along. Re-run
  // on `messages` as well, since a triage that removes rows remounts the one it lands on.
  useEffect(() => {
    if (cursorId) rowRefs.current.get(cursorId)?.focus();
  }, [cursorId, messages]);

  const openMessage = useCallback((nextMessageId: string) => {
    setMessageId(nextMessageId);
    setCursorId(nextMessageId);
  }, []);

  const toggleSelected = useCallback((toggledId: string) => {
    setSelectedIds((current) => (current.includes(toggledId) ? current.filter((id) => id !== toggledId) : [...current, toggledId]));
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
            <FolderList folders={resource.value.folders} unreadCounts={unreadCounts} selectedFolderId={folderId} onSelect={selectFolder} />
          ) : null}
        </section>
      ) : null}

      {visible.messages ? (
        <section className="mailbox__pane mailbox__pane--messages" aria-label={t("mailbox.messages")}>
          <h2 className="mailbox__pane-title">{t("mailbox.messages")}</h2>
          {!folderId ? <EmptyState message={t("mailbox.messages.empty")} /> : null}
          {folderId && messagesResource.resource.status === "loading" ? <LoadingState /> : null}
          {folderId && messagesResource.resource.status === "failed" ? (
            <ErrorState error={messagesResource.resource.error} onRetry={messagesResource.reload} />
          ) : null}
          {folderId && messagesResource.resource.status === "ready" ? (
            <MessagesPane
              config={config}
              targets={targets}
              messages={messages}
              selectedIds={selectedIds}
              cursorId={cursorId}
              openMessageId={messageId}
              failure={failure}
              onOpen={openMessage}
              onToggleSelected={toggleSelected}
              onClearSelection={() => setSelectedIds([])}
              onTriage={runTriage}
              rowRefs={rowRefs}
            />
          ) : null}
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
 *
 * Triage (issue #97) stays on the same generic surface: read and flag state are user-owned
 * checkbox properties written with `updateItem`, and archive/delete move a message between
 * folders with the generic relation link/unlink pair. Pointer and keyboard reach the same
 * actions — row buttons, a bulk toolbar over the selected messages, and `j`/`k`/`e`.
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
