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
  "mailbox.message.flagged": "Flagged",
  "mailbox.message.select": "Select this message",
  "mailbox.selection": "Selected messages",
  "mailbox.selection.count": "{count} selected",
  "mailbox.selection.clear": "Clear selection",
  "mailbox.actions.archive": "Archive",
  "mailbox.actions.delete": "Delete",
  "mailbox.actions.markRead": "Mark as read",
  "mailbox.actions.markUnread": "Mark as unread",
  "mailbox.actions.flag": "Flag",
  "mailbox.actions.unflag": "Unflag",
  "mailbox.triage.failed": "{failed} of {total} messages could not be updated",
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
  "mailbox.message.flagged": "Označeno vlaječkou",
  "mailbox.message.select": "Vybrat tuto zprávu",
  "mailbox.selection": "Vybrané zprávy",
  "mailbox.selection.count": "Vybráno: {count}",
  "mailbox.selection.clear": "Zrušit výběr",
  "mailbox.actions.archive": "Archivovat",
  "mailbox.actions.delete": "Smazat",
  "mailbox.actions.markRead": "Označit jako přečtené",
  "mailbox.actions.markUnread": "Označit jako nepřečtené",
  "mailbox.actions.flag": "Přidat vlaječku",
  "mailbox.actions.unflag": "Odebrat vlaječku",
  "mailbox.triage.failed": "{failed} z {total} zpráv se nepodařilo upravit",
  "mailbox.unconfigured": "Tento pohled na poštu není správně nakonfigurovaný",
};

export const CATALOGS = { cs, en } as const;
export type Locale = keyof typeof CATALOGS;
export const DEFAULT_LOCALE: Locale = "cs";
