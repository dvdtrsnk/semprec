import { htmlToPlainText } from "./mailPlainText.js";

export function buildMailSearchText(input: {
  subject?: string | null;
  senderName?: string | null;
  senderAddress?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  extractedTexts: string[];
}): string {
  const body = input.bodyText ?? (input.bodyHtml ? htmlToPlainText(input.bodyHtml) : "");
  const address = input.senderAddress ?? "";
  const at = address.lastIndexOf("@");
  const domain = at >= 0 ? address.slice(at + 1) : "";
  const senderWords = (input.senderAddress ?? "").match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
  return [
    input.subject ?? "",
    input.senderName ?? "",
    address,
    senderWords,
    domain,
    body,
    ...input.extractedTexts,
  ].join("\n\n");
}
