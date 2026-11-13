import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INBOX_CARD_TARGET_LABEL_KINDS } from "../inboxCardsStore.js";

const I18N_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "i18n");

function readCatalog(locale: "cs" | "en"): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(I18N_DIRECTORY, `${locale}.json`), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("catalog is no object");
  return Object.fromEntries(Object.entries(parsed));
}

describe("the target labels of Inbox cards (issue #1807)", () => {
  it.each(["cs", "en"] as const)("has a label for every labelled card kind in the %s catalog", (locale) => {
    const catalog = readCatalog(locale);

    for (const kind of INBOX_CARD_TARGET_LABEL_KINDS) {
      const label = catalog[`card.target.${kind}`];
      expect(typeof label === "string" && label.trim().length > 0, `card.target.${kind} in ${locale}.json`).toBe(true);
    }
  });

  it("labels the kinds differently in Czech and English where the words differ", () => {
    expect(readCatalog("cs")["card.target.task"]).not.toBe(readCatalog("en")["card.target.task"]);
  });
});
