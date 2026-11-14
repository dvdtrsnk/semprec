import { resolveCatalogLabel } from "@semprec/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { getInboxCatalogs } from "./inboxCatalogs.js";
import type { ItemRow } from "../types.js";
import type { InvalidReason } from "./inboxTickAction.js";

/**
 * The sentence that tells a person why a Processing proposal is `invalid` (issue #1482), in the
 * catalog of `locale` with English as the fallback. The entry is keyed by the reason's code, and
 * `{label}` is filled with the reason's stored label. The label is user content, so it is inserted
 * through a replacer function: a `$` in it is never read as a replacement pattern. The code `unknown` (issue #2027)
 * is the generic sentence for a card that has no stored reason.
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

/** The most characters (code points, not UTF-16 units) an `invalidReason` label keeps, ellipsis included. */
const INVALID_REASON_LABEL_MAX = 80;

/**
 * The source Inbox item's text as an `invalidReason` label (issue #1482): its first line, trimmed,
 * and at most `INVALID_REASON_LABEL_MAX` characters, a longer one ending with an ellipsis. Cut by
 * code point, so an emoji is never split. An item with no text, or none at all (a hard-deleted
 * source), gives the empty label.
 */
export function invalidReasonLabel(item: ItemRow | null): string {
  const text = typeof item?.properties.text === "string" ? item.properties.text : "";
  const characters = Array.from((text.split("\n")[0] ?? "").trim());
  return characters.length > INVALID_REASON_LABEL_MAX
    ? `${characters.slice(0, INVALID_REASON_LABEL_MAX - 1).join("")}…`
    : characters.join("");
}
