import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../../i18n/index.js";
import type { GenericOperations, Item, View } from "../../../api/genericOperations.js";
import { JournalInboxList, type JournalInboxItemSummary } from "../JournalInboxList.js";

const JOURNAL_DATABASE_ID = "journal-db";
const INBOX_DATABASE_ID = "inbox-db";
const DAY_ITEM_ID = "day-1";

function makeView(config: Record<string, unknown> | undefined): View {
  return { id: "view-1", databaseId: JOURNAL_DATABASE_ID, type: "journal-inbox", name: "Inbox", config: config ?? {} };
}

function makeDayItem(computed: Record<string, unknown>): Item {
  return { id: DAY_ITEM_ID, databaseId: JOURNAL_DATABASE_ID, properties: {}, computed, updatedAt: "2026-08-28T00:00:00.000Z", deletedAt: null };
}

function stubOperations(dayItem: Item | null): GenericOperations {
  return {
    async listItems() {
      return { items: [], nextCursor: null };
    },
    async countItems() {
      return 0;
    },
    async getItem(databaseId, itemId) {
      if (databaseId === JOURNAL_DATABASE_ID && itemId === DAY_ITEM_ID) return dayItem;
      return null;
    },
    async getView() {
      throw new Error("not used by this renderer");
    },
    async updateItem() {
      throw new Error("not used by this renderer");
    },
    async linkItem() {
      throw new Error("not used by this renderer");
    },
    async unlinkItem() {
      throw new Error("not used by this renderer");
    },
    async callOperation() {
      throw new Error("not used by this renderer");
    },
  };
}

function renderList(config: Record<string, unknown> | undefined, dayItem: Item | null) {
  return render(
    <I18nProvider locale="en">
      <JournalInboxList view={makeView(config)} operations={stubOperations(dayItem)} />
    </I18nProvider>,
  );
}

describe("JournalInboxList (issue #106)", () => {
  afterEach(() => cleanup());

  it("renders the day's cached Inbox items, resolving status through i18n", async () => {
    const items: JournalInboxItemSummary[] = [
      { id: "i1", date: "2026-08-28", time: "09:00", text: "Buy milk", type: { id: "t1", name: "Task", emoji: "☑️" }, status: "confirmed" },
    ];
    renderList({ inboxDatabaseId: INBOX_DATABASE_ID, journalDayItemId: DAY_ITEM_ID }, makeDayItem({ inboxItems: items }));

    expect(await screen.findByText("Buy milk")).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.getByText("☑️")).toBeInTheDocument();
  });

  it("shows the untranslated status placeholder before a proposal exists", async () => {
    const items: JournalInboxItemSummary[] = [{ id: "i1", date: "2026-08-28", time: "09:00", text: "Buy milk", type: null, status: null }];
    renderList({ inboxDatabaseId: INBOX_DATABASE_ID, journalDayItemId: DAY_ITEM_ID }, makeDayItem({ inboxItems: items }));

    expect(await screen.findByText("Not yet processed")).toBeInTheDocument();
  });

  it("shows an empty state when the day has no cached Inbox items", async () => {
    renderList({ inboxDatabaseId: INBOX_DATABASE_ID, journalDayItemId: DAY_ITEM_ID }, makeDayItem({ inboxItems: [] }));

    expect(await screen.findByText("No Inbox items for this day")).toBeInTheDocument();
  });

  it("shows an unconfigured state when the view config is missing required fields", async () => {
    renderList({ inboxDatabaseId: INBOX_DATABASE_ID }, makeDayItem({ inboxItems: [] }));

    expect(await screen.findByText("This Inbox view is not configured correctly")).toBeInTheDocument();
  });
});
