// A pre-write transform, not an item hook, because `webcal://` is rewritten to `https://` before the row is
// written. Stored URLs are otherwise kept exactly as the client sent them (no trimming).
import type { ItemPreWritePreparation, ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";
import type { ItemRow } from "../types.js";

export const CALENDAR_SUBSCRIPTION_URL_KEY = "subscriptionUrl";

const WEBCAL_SCHEME = /^webcal:\/\//i;

/**
 * `null` for `null` or the empty string (clears the address); otherwise the address with `webcal://` replaced by
 * `https://`, after the stored-URL baseline accepted it. Non-text and whitespace-only values are refused.
 */
function normalizeSubscriptionUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError("Property 'subscriptionUrl' of a calendar must be text or null", {
      field: CALENDAR_SUBSCRIPTION_URL_KEY,
    });
  }
  if (value === "") return null;
  const address = WEBCAL_SCHEME.test(value) ? `https://${value.replace(WEBCAL_SCHEME, "")}` : value;
  if (!isBaselineOutboundUrl(address)) {
    throw new ValidationError(
      "Property 'subscriptionUrl' of a calendar must be an https URL to a public DNS host, without credentials or a port",
      { field: CALENDAR_SUBSCRIPTION_URL_KEY },
    );
  }
  return address;
}

/**
 * A non-null address is accepted only when `kind` after the write is `subscription` (the patch's, else the stored
 * one; `stored` is `null` on create). Clearing is allowed on every calendar.
 */
function resolveSubscriptionUrlWrite(stored: ItemRow | null, patch: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(patch, CALENDAR_SUBSCRIPTION_URL_KEY)) return patch;
  const address = normalizeSubscriptionUrl(patch[CALENDAR_SUBSCRIPTION_URL_KEY]);
  if (address !== null) {
    const kind = Object.hasOwn(patch, "kind") ? patch.kind : stored?.properties.kind;
    if (kind !== "subscription") {
      throw new ValidationError("Only a subscription calendar can have a subscription URL", {
        field: CALENDAR_SUBSCRIPTION_URL_KEY,
      });
    }
  }
  return { ...patch, [CALENDAR_SUBSCRIPTION_URL_KEY]: address };
}

/** Runs on create and on update. */
export const calendarSubscriptionUrlTransform: ItemPreWriteTransform = async ({ stored, patch }) =>
  resolveSubscriptionUrlWrite(stored, patch);

/** Proposal-time form for an agent's proposed write: same checks and rewrite. */
export const prepareCalendarSubscriptionUrl: ItemPreWritePreparation = async ({ stored, patch }) => ({
  patch: resolveSubscriptionUrlWrite(stored, patch),
  deferredKeys: [],
});
