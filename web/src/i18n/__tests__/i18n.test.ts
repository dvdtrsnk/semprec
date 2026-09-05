import { describe, expect, it } from "vitest";
import { createTranslate, resolveLocale } from "../index.js";
import { cs, en } from "../messages.js";

describe("i18n", () => {
  it("keeps every catalog in step with the English key set", () => {
    expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
  });

  it("interpolates values into a message", () => {
    expect(createTranslate("en")("mailbox.unreadCount", { count: 3 })).toBe("3 unread");
    expect(createTranslate("cs")("mailbox.unreadCount", { count: 3 })).toBe("3 nepřečtených");
  });

  it("resolves a supported locale from the browser's languages, falling back to Czech", () => {
    expect(resolveLocale(["en-GB", "cs"])).toBe("en");
    expect(resolveLocale(["de-DE"])).toBe("cs");
    expect(resolveLocale([])).toBe("cs");
  });
});
