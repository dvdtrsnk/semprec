// The write rule of a subscription calendar's feed address (issue gh-1925): a pre-write transform of the
// Calendars database, registered through ../domainWriteHooks.ts. It is a transform, not an item hook, because a
// `webcal://` address is rewritten to `https://` before the row is written and a hook runs after it; see
// docs/adr/2026-10-29-item-pre-write-transforms-per-module-registry.md.
// Constrained by: docs/adr/2026-09-27-ssrf-protection-for-stored-outbound-urls.md. That ADR keeps a stored URL exactly
// as the client sent it; the one deviation here is the `webcal://` to `https://` rewrite the issue requires. Nothing
// else is normalized (no trimming), so the stored address is what the client sent or its `https://` form.
import type { ItemPreWritePreparation, ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";
import type { ItemRow } from "../types.js";

/** The key of the property this transform judges. */
export const CALENDAR_SUBSCRIPTION_URL_KEY = "subscriptionUrl";

const WEBCAL_SCHEME = /^webcal:\/\//i;

/**
 * The address to store for a written `subscriptionUrl`: `null` for `null` and the empty string (they clear the
 * address); otherwise the address as written, with a `webcal://` scheme replaced by `https://` (host, path and
 * query unchanged), after the stored-URL baseline accepted that result. Anything else, a value that is not text and
 * a string of only whitespace included, is refused with `validation_failed` on `subscriptionUrl`.
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
 * Judges a write of a calendar row. A patch that does not name `subscriptionUrl` is returned as it is. Otherwise
 * the value is normalized (`normalizeSubscriptionUrl`), and a non-null address is accepted only for a calendar whose
 * `kind` after the write is `subscription`: the `kind` the patch names, else the stored one (`stored` is `null` on
 * create, and a row without a `kind` is an own calendar). Clearing the address is allowed on every calendar.
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

/** Registered under the Calendars module id by `../domainWriteHooks.ts`; runs on create and on update. */
export const calendarSubscriptionUrlTransform: ItemPreWriteTransform = async ({ stored, patch }) =>
  resolveSubscriptionUrlWrite(stored, patch);

/** The proposal-time form of the transform, for a write an agent proposes: the same checks and the same rewrite. */
export const prepareCalendarSubscriptionUrl: ItemPreWritePreparation = async ({ stored, patch }) => ({
  patch: resolveSubscriptionUrlWrite(stored, patch),
  deferredKeys: [],
});
