/**
 * Message catalogs. Czech is the primary locale (this is a personal system used in Czech);
 * English is the fallback and the shape every other catalog is checked against by the
 * `Messages` type, so a missing key is a type error rather than a blank label at runtime.
 */
export const en = {
  "state.loading": "Loading…",
  "state.retry": "Try again",
  "state.error.title": "Something went wrong",
  "state.unavailable.title": "Not available",
  "mailbox.folders": "Folders",
  "mailbox.messages": "Messages",
  "mailbox.message": "Message",
  "mailbox.back": "Back",
  "mailbox.unreadCount": "{count} unread",
  "mailbox.folders.empty": "No folders yet",
  "mailbox.messages.empty": "No messages in this folder",
  "mailbox.message.none": "Select a message to read it",
  "mailbox.message.noSubject": "(no subject)",
  "mailbox.message.from": "From",
  "mailbox.message.to": "To",
  "mailbox.message.unread": "Unread",
  "mailbox.unconfigured": "This mailbox view is not configured correctly",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

export const cs: Messages = {
  "state.loading": "Načítání…",
  "state.retry": "Zkusit znovu",
  "state.error.title": "Něco se nepovedlo",
  "state.unavailable.title": "Není k dispozici",
  "mailbox.folders": "Složky",
  "mailbox.messages": "Zprávy",
  "mailbox.message": "Zpráva",
  "mailbox.back": "Zpět",
  "mailbox.unreadCount": "{count} nepřečtených",
  "mailbox.folders.empty": "Zatím žádné složky",
  "mailbox.messages.empty": "V této složce nejsou žádné zprávy",
  "mailbox.message.none": "Vyberte zprávu, kterou chcete číst",
  "mailbox.message.noSubject": "(bez předmětu)",
  "mailbox.message.from": "Od",
  "mailbox.message.to": "Komu",
  "mailbox.message.unread": "Nepřečteno",
  "mailbox.unconfigured": "Tento pohled na poštu není správně nakonfigurovaný",
};

export const CATALOGS = { cs, en } as const;
export type Locale = keyof typeof CATALOGS;
export const DEFAULT_LOCALE: Locale = "cs";
