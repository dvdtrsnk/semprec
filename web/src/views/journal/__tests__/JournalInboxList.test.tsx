import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function stubOperations(getItem: GenericOperations["getItem"]): GenericOperations {
  return {
    async listItems() {
      return { items: [], nextCursor: null };
    },
    async countItems() {
      return 0;
    },
    getItem,
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
  const getItem: GenericOperations["getItem"] = async (databaseId, itemId) =>
    databaseId === JOURNAL_DATABASE_ID && itemId === DAY_ITEM_ID ? dayItem : null;
  return render(
    <I18nProvider locale="en">
      <JournalInboxList view={makeView(config)} operations={stubOperations(getItem)} />
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

  it("shows an error state when the day fails to load, and retries on demand", async () => {
    let calls = 0;
    const getItem: GenericOperations["getItem"] = async () => {
      calls++;
      if (calls === 1) throw new Error("network blip");
      return makeDayItem({ inboxItems: [] });
    };
    render(
      <I18nProvider locale="en">
        <JournalInboxList
          view={makeView({ inboxDatabaseId: INBOX_DATABASE_ID, journalDayItemId: DAY_ITEM_ID })}
          operations={stubOperations(getItem)}
        />
      </I18nProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("network blip");
    expect(calls).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No Inbox items for this day")).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("treats a malformed cached payload as an error rather than rendering garbage", async () => {
    renderList({ inboxDatabaseId: INBOX_DATABASE_ID, journalDayItemId: DAY_ITEM_ID }, makeDayItem({ inboxItems: [{ id: "i1" }] }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
