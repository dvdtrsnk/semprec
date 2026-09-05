import { useId } from "react";
import { useTranslate } from "../../i18n/index.js";
import type { AliasOption, ComposeError, ComposeState } from "./compose.js";

/**
 * The compose surface, in its two placements: a floating window that hovers over the mailbox
 * (and minimizes to a title bar without losing anything) and the inline reply that lives under
 * the message being read. Both render the same fields and hand the same actions back — they
 * differ only in where they sit, which is why the window can be open while a thread is being
 * replied to inline.
 *
 * Neither owns its content: the state lives above them, so minimizing the window, walking
 * through other messages, or a send the backend rejects all leave what was typed untouched.
 */
export interface ComposeHandlers {
  onChange: (patch: Partial<ComposeState>) => void;
  onSave: () => void;
  onSend: () => void;
  onClose: () => void;
}

export interface ComposeProps extends ComposeHandlers {
  state: ComposeState;
  aliases: readonly AliasOption[];
}

function ComposeErrorMessage({ error }: { error: ComposeError }) {
  const t = useTranslate();
  const message =
    error.kind === "failed"
      ? t("mailbox.compose.error.failed", { message: error.message })
      : t(error.problem === "noSender" ? "mailbox.compose.error.noSender" : "mailbox.compose.error.noRecipients");
  return (
    <p className="compose__error" role="alert">
      {message}
    </p>
  );
}

function ComposeFields({ state, aliases, onChange, onSave, onSend, onClose }: ComposeProps) {
  const t = useTranslate();
  const ids = useId();
  const field = (name: string) => `${ids}-${name}`;
  // The fields are frozen while a save or send is in flight: the state that comes back is the
  // one that was submitted, so accepting edits meanwhile would quietly discard them.
  const busy = state.status === "saving" || state.status === "sending";

  return (
    <div className="compose__body">
      <div className="compose__field">
        <label htmlFor={field("from")}>{t("mailbox.compose.from")}</label>
        {/* A plain dropdown over the registered aliases — the same list the backend's send
            path validates the From address against, so an address it would reject is not
            offerable here in the first place. */}
        <select id={field("from")} value={state.fromAddress} disabled={busy} onChange={(event) => onChange({ fromAddress: event.target.value })}>
          {aliases.map((alias) => (
            <option key={alias.address} value={alias.address}>
              {`${alias.address} (${alias.mailboxName})`}
            </option>
          ))}
        </select>
      </div>

      <div className="compose__field">
        <label htmlFor={field("to")}>{t("mailbox.compose.to")}</label>
        <input id={field("to")} type="text" value={state.to} disabled={busy} onChange={(event) => onChange({ to: event.target.value })} />
      </div>

      {state.showCopies ? (
        <>
          <div className="compose__field">
            <label htmlFor={field("cc")}>{t("mailbox.compose.cc")}</label>
            <input id={field("cc")} type="text" value={state.cc} disabled={busy} onChange={(event) => onChange({ cc: event.target.value })} />
          </div>
          <div className="compose__field">
            <label htmlFor={field("bcc")}>{t("mailbox.compose.bcc")}</label>
            <input id={field("bcc")} type="text" value={state.bcc} disabled={busy} onChange={(event) => onChange({ bcc: event.target.value })} />
          </div>
        </>
      ) : (
        <button type="button" className="button compose__copies" disabled={busy} onClick={() => onChange({ showCopies: true })}>
          {t("mailbox.compose.showCopies")}
        </button>
      )}

      <div className="compose__field">
        <label htmlFor={field("subject")}>{t("mailbox.compose.subject")}</label>
        <input id={field("subject")} type="text" value={state.subject} disabled={busy} onChange={(event) => onChange({ subject: event.target.value })} />
      </div>

      <div className="compose__field compose__field--body">
        <label htmlFor={field("body")}>{t("mailbox.compose.body")}</label>
        <textarea id={field("body")} rows={10} value={state.body} disabled={busy} onChange={(event) => onChange({ body: event.target.value })} />
      </div>

      {state.error ? <ComposeErrorMessage error={state.error} /> : null}

      <div className="compose__actions">
        <button type="button" className="button" onClick={onSend} disabled={busy}>
          {state.status === "sending" ? t("mailbox.compose.sending") : t("mailbox.compose.send")}
        </button>
        {/* `email.draft.create` is create-only, so a session saves one draft; what is typed
            after that stays here and is written onto that draft by the send itself. */}
        <button type="button" className="button" onClick={onSave} disabled={busy || state.draftItemId !== null}>
          {state.status === "saving" ? t("mailbox.compose.saving") : t("mailbox.compose.save")}
        </button>
        {state.draftItemId ? (
          <span className="compose__saved" role="status">
            {t("mailbox.compose.saved")}
          </span>
        ) : null}
        <button type="button" className="button" onClick={onClose} disabled={busy}>
          {t("mailbox.compose.close")}
        </button>
      </div>
    </div>
  );
}

/** The floating new-message window: independent of whatever the reading pane is showing. */
export function ComposeWindow(props: ComposeProps) {
  const t = useTranslate();
  const { state, onChange } = props;
  const title = state.subject.trim().length > 0 ? state.subject : t("mailbox.compose.newMessage");

  return (
    <section
      className={`compose compose--window${state.minimized ? " compose--minimized" : ""}`}
      role="dialog"
      aria-label={t("mailbox.compose.newMessage")}
    >
      <header className="compose__header">
        <h2 className="compose__title">{title}</h2>
        <button type="button" className="button" onClick={() => onChange({ minimized: !state.minimized })}>
          {t(state.minimized ? "mailbox.compose.restore" : "mailbox.compose.minimize")}
        </button>
      </header>
      {state.minimized ? null : <ComposeFields {...props} />}
    </section>
  );
}

/** The reply that belongs to the message being read, rendered under it in the reading pane. */
export function InlineCompose(props: ComposeProps) {
  const t = useTranslate();
  const label = props.state.mode === "replyAll" ? t("mailbox.compose.replyAll") : t("mailbox.compose.reply");

  return (
    <section className="compose compose--inline" aria-label={label}>
      <h4 className="compose__title">{label}</h4>
      <ComposeFields {...props} />
    </section>
  );
}
