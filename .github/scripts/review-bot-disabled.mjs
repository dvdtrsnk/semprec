/** Print whether the repository owner has explicitly paused automated review. Invalid policy fails closed. */
import { readFileSync } from "node:fs";
import { isEntryScript } from "./is-entry-script.mjs";

export function reviewBotDisabled(path = new URL("../../.relay/review-policy.json", import.meta.url)) {
  const policy = JSON.parse(readFileSync(path, "utf8"));
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)
      || typeof policy.enabled !== "boolean" || typeof policy.reason !== "string" || !policy.reason.trim()) {
    throw new Error("Review policy requires a boolean enabled and a non-empty reason");
  }
  return !policy.enabled;
}

if (isEntryScript(import.meta.url)) console.log(reviewBotDisabled(process.argv[2]));
