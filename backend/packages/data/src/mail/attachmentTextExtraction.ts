import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * "Attachments (PDF/DOCX) are indexed by extracting text at ingest time" (issue #26) — pure
 * JS libraries (`pdf-parse`/`mammoth`), not `pdftotext`/poppler-utils as the issue's own text
 * names: an OS-level binary is one more thing a deployment must install outside `pnpm
 * install` and isn't guaranteed present in every environment this runs in (the same
 * "OS-level asset" reasoning the migration's own Czech-search comment already applies to
 * hunspell). Functionally equivalent — text out, same destination (`item_search_index` via
 * `ingest.ts`'s `reindexItemSearch` call).
 *
 * Best-effort: a corrupt/password-protected/malformed file must not fail the whole message
 * ingest over a search-indexing nicety, so extraction errors are the caller's problem to
 * swallow, not this function's — it only throws on a genuine parse failure, same as the
 * underlying libraries do.
 */
export async function extractAttachmentText(contentType: string, bytes: Buffer): Promise<string | null> {
  if (contentType === "application/pdf") {
    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  if (contentType === DOCX_CONTENT_TYPE) {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value;
  }
  return null;
}

/** Whether `extractAttachmentText` has any handling for this content type at all — lets callers decide whether to pay for buffering an attachment's bytes before it's worth attempting extraction. */
export function isTextExtractableContentType(contentType: string): boolean {
  return contentType === "application/pdf" || contentType === DOCX_CONTENT_TYPE;
}
