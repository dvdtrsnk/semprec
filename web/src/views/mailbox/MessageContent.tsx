import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LoadingState } from "../../components/StateViews.js";
import { useLocale, useTranslate, type Translate } from "../../i18n/index.js";
import { formatByteSize } from "../../i18n/format.js";
import { toOperationError, type OperationError } from "../../api/genericOperations.js";
import {
  MailMessageError,
  type MailMessageAttachment,
  type MailMessageContent,
  type MailMessageOperations,
} from "../../api/mailMessageOperations.js";

type ContentLoad =
  | { status: "loading" }
  | { status: "ready"; content: MailMessageContent }
  | { status: "failed"; error: OperationError };

type AttachmentSave = { status: "saving" } | { status: "failed"; error: OperationError };

/** What a failed content read or attachment save tells the reader: the reason the backend gave, else the status. */
function failureText(t: Translate, error: OperationError): string {
  if (error instanceof MailMessageError) {
    const { failure } = error;
    if (failure.code === "contentUnavailable") return t(`mailbox.content.error.${failure.reason}`);
    if (failure.code === "rateLimited") return t("mailbox.content.error.rateLimited");
    return t("mailbox.content.error.notFound");
  }
  return typeof error.status === "number"
    ? t("state.error.status", { status: error.status })
    : t("state.error.transport");
}

/**
 * One message's body and attachments, always read through the content route, which answers a
 * stored body as well as one it fetches from the mail provider on demand. A refresh (after an
 * attachment was saved) keeps the shown content until the new answer arrives; an answer to an
 * earlier read than the latest is dropped.
 */
function useMessageContent(mailMessages: MailMessageOperations, emailId: string) {
  const [load, setLoad] = useState<ContentLoad>({ status: "loading" });
  const latest = useRef(0);

  // Settles in both branches, so it never rejects.
  const read = useCallback(
    (showLoading: boolean): Promise<void> => {
      const request = ++latest.current;
      if (showLoading) setLoad({ status: "loading" });
      return mailMessages.getContent(emailId).then(
        (content) => {
          if (latest.current === request) setLoad({ status: "ready", content });
        },
        (error: unknown) => {
          if (latest.current === request) setLoad({ status: "failed", error: toOperationError(error) });
        },
      );
    },
    [mailMessages, emailId],
  );

  useEffect(() => {
    void read(true);
    return () => {
      latest.current += 1;
    };
  }, [read]);

  return { load, retry: () => void read(true), refresh: () => read(false) };
}

function AttachmentRow({
  attachment,
  href,
  save,
  onSave,
}: {
  attachment: MailMessageAttachment;
  /** Where the stored bytes open; `null` while they are not stored. */
  href: string | null;
  save: AttachmentSave | undefined;
  onSave: () => void;
}) {
  const t = useTranslate();
  const locale = useLocale();
  const nameId = useId();

  return (
    <li className="attachment-list__row">
      {href === null ? (
        <span className="attachment-list__name" id={nameId}>
          {attachment.filename}
        </span>
      ) : (
        // The blob route serves a type it can show safely inline and has every other one downloaded.
        <a className="attachment-list__name" id={nameId} href={href} target="_blank" rel="noreferrer">
          {attachment.filename}
        </a>
      )}
      <span className="attachment-list__type">{attachment.contentType}</span>
      <span className="attachment-list__size">{formatByteSize(locale, attachment.byteSize)}</span>
      {href === null ? (
        <button
          type="button"
          className="button attachment-list__save"
          aria-describedby={nameId}
          disabled={save?.status === "saving"}
          onClick={onSave}
        >
          {save?.status === "saving" ? t("mailbox.attachments.saving") : t("mailbox.attachments.save")}
        </button>
      ) : null}
      {save?.status === "failed" ? (
        <p className="attachment-list__error" role="alert">
          {t("mailbox.attachments.saveFailed", { reason: failureText(t, save.error) })}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The body of the message being read, as plain text, and its attachments: a stored one opens from
 * the blob route, one whose bytes were never stored offers "Save to Files", which stores it and
 * then reads the content again so it shows as stored.
 */
export function MessageContent({ mailMessages, emailId }: { mailMessages: MailMessageOperations; emailId: string }) {
  const t = useTranslate();
  const { load, retry, refresh } = useMessageContent(mailMessages, emailId);
  const [saves, setSaves] = useState<Record<string, AttachmentSave>>({});

  // Settles in every branch: a failed save is shown on its row, a failed refresh as the content's failure.
  const save = async (attachmentId: string) => {
    setSaves((current) => ({ ...current, [attachmentId]: { status: "saving" } }));
    try {
      await mailMessages.saveAttachment(emailId, attachmentId);
    } catch (error) {
      const failed: AttachmentSave = { status: "failed", error: toOperationError(error) };
      setSaves((current) => ({ ...current, [attachmentId]: failed }));
      return;
    }
    await refresh();
    setSaves((current) => {
      const { [attachmentId]: _saved, ...rest } = current;
      return rest;
    });
  };

  if (load.status === "loading") return <LoadingState label={t("mailbox.content.loading")} />;
  if (load.status === "failed") {
    // Only a message that is gone offers no retry: a new sign-in or the account switched back on
    // happens elsewhere, and the reader then comes back here to try again.
    const gone = load.error instanceof MailMessageError && load.error.failure.code === "notFound";
    return (
      <div className="state state--error" role="alert">
        <p className="state__title">{t("mailbox.content.error.title")}</p>
        <p className="state__detail">{failureText(t, load.error)}</p>
        {gone ? null : (
          <button type="button" className="button" onClick={retry}>
            {t("state.retry")}
          </button>
        )}
      </div>
    );
  }

  const { content } = load;
  return (
    <>
      {/* Rendered as text, never as markup: the body is untrusted remote content. */}
      <p className="reading-pane__body">{content.bodyText}</p>
      {content.attachments.length > 0 ? (
        <ul className="attachment-list" aria-label={t("mailbox.attachments")}>
          {content.attachments.map((attachment) => (
            <AttachmentRow
              key={attachment.attachmentId}
              attachment={attachment}
              href={attachment.blobId === null ? null : mailMessages.blobUrl(attachment.blobId)}
              save={saves[attachment.attachmentId]}
              onSave={() => void save(attachment.attachmentId)}
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}
