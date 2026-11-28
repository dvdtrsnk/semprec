import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import { I18nProvider } from "../i18n/index.js";
import type { GenericOperations, View } from "../api/genericOperations.js";
import type { MailDraftOperations } from "../api/mailDraftOperations.js";
import type { MailMessageOperations } from "../api/mailMessageOperations.js";
import { MailboxClient } from "../views/mailbox/MailboxClient.js";
import { createFakeMailDrafts } from "./fakeMailDrafts.js";
import { createFakeMailMessages } from "./fakeMailMessages.js";
import { createMailboxBackend, mailboxView } from "./mailboxFixture.js";

/** jsdom implements no `matchMedia`; the layout hook reads it, so every test declares a width. */
export function setViewport(isNarrow: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: isNarrow,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

export function renderMailbox(
  operations: GenericOperations,
  options: {
    view?: View;
    locale?: "cs" | "en";
    mailDrafts?: MailDraftOperations;
    /** Defaults to message routes over a fixture mailbox, serving its stored bodies without attachments. */
    mailMessages?: MailMessageOperations;
  } = {},
): RenderResult {
  // A test that does not exercise compose gets draft routes with no mail module behind them.
  const mailDrafts = options.mailDrafts ?? createFakeMailDrafts({ items: [], relations: [], views: [] });
  const mailMessages = options.mailMessages ?? createFakeMailMessages(createMailboxBackend());
  return render(
    <I18nProvider locale={options.locale ?? "en"}>
      <MailboxClient
        view={options.view ?? mailboxView}
        operations={operations}
        mailDrafts={mailDrafts}
        mailMessages={mailMessages}
      />
    </I18nProvider>,
  );
}
