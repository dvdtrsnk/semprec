import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import { I18nProvider } from "../i18n/index.js";
import type { GenericOperations, View } from "../api/genericOperations.js";
import { MailboxClient } from "../views/mailbox/MailboxClient.js";
import { mailboxView } from "./mailboxFixture.js";

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

export function renderMailbox(operations: GenericOperations, options: { view?: View; locale?: "cs" | "en" } = {}): RenderResult {
  return render(
    <I18nProvider locale={options.locale ?? "en"}>
      <MailboxClient view={options.view ?? mailboxView} operations={operations} />
    </I18nProvider>,
  );
}
