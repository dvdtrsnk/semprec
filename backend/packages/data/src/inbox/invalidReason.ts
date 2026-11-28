import { resolveCatalogLabel } from "@alldots/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { getInboxCatalogs } from "./inboxCatalogs.js";
import type { ItemRow } from "../types.js";
import type { InvalidReason } from "./inboxTickAction.js";

/**
 * The label is user content, so it goes through a replacer function and a `$` is never read as a pattern. The code
 * `unknown` is the generic sentence for a card with no stored reason.
 */
export async function renderInvalidReason(
  reason: Pick<InvalidReason, "label"> & { code: InvalidReason["code"] | "unknown" },
  locale: string,
): Promise<string> {
  const catalogs = await getInboxCatalogs();
  const template = resolveCatalogLabel(
    null,
    catalogs[toManifestLocale(locale)],
    catalogs.en,
    `invalidReason.${reason.code}`,
  );
  return template.replaceAll("{label}", () => reason.label);
}

/** Counted in code points, ellipsis included. */
const INVALID_REASON_LABEL_MAX = 80;

/** The first line, trimmed and cut by code point so an emoji is never split; empty for no text or no item. */
export function invalidReasonLabel(item: ItemRow | null): string {
  const text = typeof item?.properties.text === "string" ? item.properties.text : "";
  const characters = Array.from((text.split("\n")[0] ?? "").trim());
  return characters.length > INVALID_REASON_LABEL_MAX
    ? `${characters.slice(0, INVALID_REASON_LABEL_MAX - 1).join("")}…`
    : characters.join("");
}
