import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Extracts PDF/DOCX text for the search index at ingest. Pure JS libraries rather than
 * poppler's `pdftotext`, so no OS-level binary must be installed. Throws on a parse failure;
 * the caller decides whether that may fail the ingest.
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

/** Lets callers skip buffering an attachment whose type cannot be extracted. */
export function isTextExtractableContentType(contentType: string): boolean {
  return contentType === "application/pdf" || contentType === DOCX_CONTENT_TYPE;
}
