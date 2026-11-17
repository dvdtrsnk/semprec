import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEARCH_ITEM_GROUP_TYPES } from "@semprec/shared";
import "../../domainWriteHooks.js";
import {
  clearSearchGroupsForTests,
  getSearchGroup,
  registerItemSearchGroup,
  registerThreadSearchGroup,
  type ItemSearchGroup,
  type ThreadSearchGroup,
} from "../searchGroupRegistry.js";
import { mailGlobalSearchGroup } from "../../mail/mailGlobalSearchGroup.js";
import { sempThreadSearchGroup } from "../sempThreadSearch.js";

// The registration of the composition root is read first, before a test empties the registry.
const composedItemGroups = SEARCH_ITEM_GROUP_TYPES.map((type) => getSearchGroup(type));
const composedMail = getSearchGroup("mail");
const composedChat = getSearchGroup("chat");

function threadGroup(type: ThreadSearchGroup["type"]): ThreadSearchGroup {
  return { type, prepare: () => async () => ({ total: 0, items: [], nextCursor: null }) };
}

describe("the registry that domainWriteHooks fills", () => {
  it("holds the seven item groups with exactly their owner modules, and the chat thread group", () => {
    expect(
      composedItemGroups.map((group) => group && { type: group.type, ownerModuleIds: [...group.ownerModuleIds] }),
    ).toEqual([
      { type: "task", ownerModuleIds: ["tasks"] },
      { type: "event", ownerModuleIds: ["events"] },
      { type: "project", ownerModuleIds: ["projects"] },
      { type: "area", ownerModuleIds: ["areas"] },
      { type: "contact", ownerModuleIds: ["people", "companies"] },
      { type: "journal", ownerModuleIds: ["journal"] },
      { type: "file", ownerModuleIds: ["files"] },
    ]);
    expect(composedChat).toBe(sempThreadSearchGroup);
  });

  it("holds the mail thread group", () => {
    expect(composedMail).toBe(mailGlobalSearchGroup);
  });
});

describe("searchGroupRegistry", () => {
  beforeEach(() => {
    clearSearchGroupsForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers undefined for a type that was never registered", () => {
    expect(getSearchGroup("task")).toBeUndefined();
    expect(getSearchGroup("mail")).toBeUndefined();
  });

  it("returns the registered item group and the registered thread group by their types", () => {
    const task: ItemSearchGroup = { type: "task", ownerModuleIds: ["tasks"] };
    const mail = threadGroup("mail");
    registerItemSearchGroup(task);
    registerThreadSearchGroup(mail);
    expect(getSearchGroup("task")).toBe(task);
    expect(getSearchGroup("mail")).toBe(mail);
    expect(getSearchGroup("chat")).toBeUndefined();
  });

  it("makes registering the same item group twice a no-op", () => {
    const task: ItemSearchGroup = { type: "task", ownerModuleIds: ["tasks"] };
    registerItemSearchGroup(task);
    expect(() => registerItemSearchGroup(task)).not.toThrow();
    expect(getSearchGroup("task")).toBe(task);
  });

  it("makes registering the same thread group twice a no-op", () => {
    const mail = threadGroup("mail");
    registerThreadSearchGroup(mail);
    expect(() => registerThreadSearchGroup(mail)).not.toThrow();
    expect(getSearchGroup("mail")).toBe(mail);
  });

  it("refuses a different item group for a type that has one, and keeps the first", () => {
    const first: ItemSearchGroup = { type: "task", ownerModuleIds: ["tasks"] };
    registerItemSearchGroup(first);
    expect(() => registerItemSearchGroup({ type: "task", ownerModuleIds: ["events"] })).toThrow(
      'A search group is already registered for type "task"',
    );
    expect(getSearchGroup("task")).toBe(first);
  });

  it("refuses a different thread group for a type that has one, and keeps the first", () => {
    const first = threadGroup("mail");
    registerThreadSearchGroup(first);
    expect(() => registerThreadSearchGroup(threadGroup("mail"))).toThrow(
      'A search group is already registered for type "mail"',
    );
    expect(getSearchGroup("mail")).toBe(first);
  });

  it("is emptied by clearSearchGroupsForTests", () => {
    registerItemSearchGroup({ type: "task", ownerModuleIds: ["tasks"] });
    registerThreadSearchGroup(threadGroup("chat"));
    clearSearchGroupsForTests();
    expect(getSearchGroup("task")).toBeUndefined();
    expect(getSearchGroup("chat")).toBeUndefined();
  });

  it("refuses to be emptied outside a test, and keeps the registrations", () => {
    const task: ItemSearchGroup = { type: "task", ownerModuleIds: ["tasks"] };
    registerItemSearchGroup(task);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => clearSearchGroupsForTests()).toThrow("clearSearchGroupsForTests() must only be called in tests");
    vi.unstubAllEnvs();
    expect(getSearchGroup("task")).toBe(task);
  });
});
