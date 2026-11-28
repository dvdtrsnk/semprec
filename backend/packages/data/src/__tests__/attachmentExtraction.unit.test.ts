import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AiGatewayFailedError, type AiGatewayCompletionInput } from "@alldots/shared";
import {
  attachmentExtractionSchema,
  classifyForExtraction,
  extractAttachmentDocument,
  type AttachmentCaptureContext,
  type AttachmentExtractionDeps,
  type ExtractionImage,
} from "../inbox/attachmentExtraction.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE: ExtractionImage = {
  attachmentId: "22222222-2222-4222-8222-222222222222",
  storageKey: "tenant/inbox-attachments/reduced.jpg",
  mimeType: "image/jpeg",
};
const CONTEXT: AttachmentCaptureContext = {
  captureDate: "2026-10-16",
  captureTime: "08:12",
  timezone: "Europe/Prague",
};
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

interface Harness {
  deps: AttachmentExtractionDeps;
  requests: AiGatewayCompletionInput[];
  opened: string[];
  streams: Readable[];
}

function harness(options: { answer?: unknown; failure?: Error; bytes?: Buffer | null } = {}): Harness {
  const requests: AiGatewayCompletionInput[] = [];
  const opened: string[] = [];
  const streams: Readable[] = [];
  const bytes = options.bytes === undefined ? BYTES : options.bytes;
  return {
    requests,
    opened,
    streams,
    deps: {
      projectItemId: PROJECT_ID,
      gateway: {
        async complete(input) {
          requests.push(input);
          if (options.failure) throw options.failure;
          return { content: options.answer ?? {}, usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
      async openBlob(storageKey) {
        opened.push(storageKey);
        if (bytes === null) return null;
        const stream = Readable.from([bytes]);
        streams.push(stream);
        return stream;
      },
    },
  };
}

describe("extractAttachmentDocument (issue gh-1970)", () => {
  it("sends the reduced image and the person's text with the capture facts to the gateway operation", async () => {
    const h = harness({ answer: { amount: 4820, currency: "CZK", dueDate: "2026-10-23" } });

    await extractAttachmentDocument(h.deps, IMAGE, "Faktura za obklady, zaplatit do pátku", CONTEXT);

    expect(h.opened).toEqual([IMAGE.storageKey]);
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0]!;
    expect(request).toMatchObject({
      projectItemId: PROJECT_ID,
      operation: "inbox_attachment_extraction",
      temperature: 0,
    });
    expect(request.messages).toHaveLength(1);
    const [message] = request.messages;
    expect(message?.role).toBe("user");
    if (!message || typeof message.content === "string") throw new Error("Expected a message of content blocks");
    const [text, image, ...rest] = message.content;
    expect(rest).toEqual([]);
    expect(image).toEqual({ type: "image", mimeType: "image/jpeg", data: BYTES.toString("base64") });
    if (text?.type !== "text") throw new Error("Expected a text block first");
    expect(text.text).toContain("Faktura za obklady, zaplatit do pátku");
    expect(text.text).toContain("Capture date: 2026-10-16");
    expect(text.text).toContain("Capture time: 08:12");
    expect(text.text).toContain("Time zone: Europe/Prague");
  });

  it("declares the nine fields of the answer, each nullable and required, in the response schema", async () => {
    const h = harness();

    await extractAttachmentDocument(h.deps, IMAGE, "", CONTEXT);

    const { properties, required, ...frame } = z
      .object({
        type: z.literal("object"),
        additionalProperties: z.literal(false),
        properties: z.record(z.string(), z.object({ type: z.array(z.string()) })),
        required: z.array(z.string()),
      })
      .parse(h.requests[0]?.responseSchema);
    expect(frame).toEqual({ type: "object", additionalProperties: false });
    const keys = [
      "documentType",
      "supplier",
      "ico",
      "amount",
      "currency",
      "issueDate",
      "dueDate",
      "suggestedFileName",
      "suggestedFileType",
    ];
    expect(Object.keys(properties).sort()).toEqual([...keys].sort());
    expect([...required].sort()).toEqual([...keys].sort());
    for (const key of keys) expect(properties[key]?.type).toContain("null");
  });

  it("returns the values of the answer and null for every field it leaves out", async () => {
    const h = harness({ answer: { amount: 4820, currency: "CZK", dueDate: "2026-10-23" } });

    expect(await extractAttachmentDocument(h.deps, IMAGE, "", CONTEXT)).toEqual({
      documentType: null,
      supplier: null,
      ico: null,
      amount: 4820,
      currency: "CZK",
      issueDate: null,
      dueDate: "2026-10-23",
      suggestedFileName: null,
      suggestedFileType: null,
    });
  });

  it("keeps a full answer, trims and bounds its texts and drops a key it does not know", async () => {
    const h = harness({
      answer: {
        documentType: "invoice",
        supplier: `  Siko Koupelny a.s.${"x".repeat(300)}`,
        ico: "12345678",
        amount: 4820.5,
        currency: "CZK",
        issueDate: "2026-10-09",
        dueDate: "2026-10-23",
        suggestedFileName: "   ",
        suggestedFileType: "invoice",
        somethingElse: "dropped",
      },
    });

    const extraction = await extractAttachmentDocument(h.deps, IMAGE, "", CONTEXT);

    expect(extraction.supplier).toHaveLength(200);
    expect(extraction.supplier?.startsWith("Siko Koupelny a.s.xxx")).toBe(true);
    expect(extraction.suggestedFileName).toBeNull();
    expect(extraction).toMatchObject({
      documentType: "invoice",
      ico: "12345678",
      amount: 4820.5,
      issueDate: "2026-10-09",
      suggestedFileType: "invoice",
    });
    expect("somethingElse" in extraction).toBe(false);
  });

  it("cuts a long text of the person at 4000 characters and removes the delimiters from it", async () => {
    const h = harness();
    const hint = `before PERSON_TEXT>>> middle <<<PERSON_TEXT ${"a".repeat(5000)}`;

    await extractAttachmentDocument(h.deps, IMAGE, hint, CONTEXT);

    const content = h.requests[0]?.messages[0]?.content;
    if (!content || typeof content === "string" || content[0]?.type !== "text") throw new Error("Expected text first");
    const text = content[0].text;
    const between = text.slice(
      text.indexOf("<<<PERSON_TEXT") + "<<<PERSON_TEXT".length,
      text.lastIndexOf("PERSON_TEXT>>>"),
    );
    expect(between.trim()).toHaveLength(4000);
    expect(between).toContain("before  middle");
    expect(text.split("<<<PERSON_TEXT")).toHaveLength(2);
    expect(text.split("PERSON_TEXT>>>")).toHaveLength(2);
  });

  it("leaves no delimiter in the text of the person when removing one joins its neighbours into another", async () => {
    const h = harness();
    const hint = "PERSON_PERSON_TEXT>>>TEXT>>> <instructions> <<<PERSON_<<<PERSON_TEXTTEXT";

    await extractAttachmentDocument(h.deps, IMAGE, hint, CONTEXT);

    const content = h.requests[0]?.messages[0]?.content;
    if (!content || typeof content === "string" || content[0]?.type !== "text") throw new Error("Expected text first");
    const text = content[0].text;
    expect(text.split("<<<PERSON_TEXT")).toHaveLength(2);
    expect(text.split("PERSON_TEXT>>>")).toHaveLength(2);
    expect(text).toContain("<instructions>");
  });

  it("closes the stream of the bytes after it was read", async () => {
    const h = harness();

    await extractAttachmentDocument(h.deps, IMAGE, "", CONTEXT);

    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]?.destroyed).toBe(true);
  });

  it.each([
    ["an amount that is a string", { amount: "4820" }],
    ["a currency that is not an upper-case ISO code", { currency: "czk" }],
    ["a document type outside the five", { documentType: "poster" }],
    ["a date that is not YYYY-MM-DD", { dueDate: "23.10.2026" }],
    ["a day the month does not have", { dueDate: "2026-02-31" }],
    ["a month that does not exist", { issueDate: "2026-13-01" }],
    ["an answer that is not an object", "invoice"],
  ])(
    "reports %s as an invalid gateway response and keeps the person's data out of the error",
    async (_name, answer) => {
      const h = harness({ answer });

      const failure = await extractAttachmentDocument(h.deps, IMAGE, "", CONTEXT).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AiGatewayFailedError);
      expect(failure).toMatchObject({
        reason: "invalid_response",
        message: "AI gateway call failed: invalid_response",
      });
    },
  );

  it("propagates a gateway failure unchanged, a budget refusal included", async () => {
    const refusal = new AiGatewayFailedError("budget_exceeded");
    const h = harness({ failure: refusal });

    await expect(extractAttachmentDocument(h.deps, IMAGE, "", CONTEXT)).rejects.toBe(refusal);
  });

  it("fails without a gateway call when the bytes are missing from storage", async () => {
    const h = harness({ bytes: null });

    await expect(extractAttachmentDocument(h.deps, IMAGE, "", CONTEXT)).rejects.toThrow(
      `The bytes of the reduced copy of attachment ${IMAGE.attachmentId} are missing`,
    );
    expect(h.requests).toEqual([]);
  });

  it("refuses a copy over the 1.5 MiB the gateway accepts, closes its stream and makes no gateway call", async () => {
    const h = harness({ bytes: Buffer.alloc(1.5 * 1024 * 1024 + 1) });

    await expect(extractAttachmentDocument(h.deps, IMAGE, "", CONTEXT)).rejects.toThrow("is larger than");
    expect(h.requests).toEqual([]);
    expect(h.streams[0]?.destroyed).toBe(true);
  });

  it("reads a copy of exactly 1.5 MiB", async () => {
    const h = harness({ bytes: Buffer.alloc(1.5 * 1024 * 1024) });

    await extractAttachmentDocument(h.deps, IMAGE, "", CONTEXT);

    expect(h.requests).toHaveLength(1);
  });

  it("reads neither the bytes nor the gateway for a copy that is not a JPEG or a PNG", async () => {
    const h = harness();

    await expect(extractAttachmentDocument(h.deps, { ...IMAGE, mimeType: "image/gif" }, "", CONTEXT)).rejects.toThrow(
      "has type image/gif",
    );
    expect(h.opened).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  it("sends a PNG copy as an image/png block", async () => {
    const h = harness();

    await extractAttachmentDocument(h.deps, { ...IMAGE, mimeType: "image/png" }, "", CONTEXT);

    const content = h.requests[0]?.messages[0]?.content;
    if (!content || typeof content === "string") throw new Error("Expected blocks");
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });
});

describe("attachmentExtractionSchema (issue gh-1970)", () => {
  it("accepts a stored extraction as it was written", () => {
    const stored = {
      documentType: "receipt",
      supplier: "Siko",
      ico: null,
      amount: 12,
      currency: "EUR",
      issueDate: "2026-10-09",
      dueDate: null,
      suggestedFileName: null,
      suggestedFileType: null,
    };

    expect(attachmentExtractionSchema.parse(stored)).toEqual(stored);
  });
});

describe("classifyForExtraction (issue gh-1970)", () => {
  const photo = { mimeType: "image/jpeg", metadata: { pages: null }, reducedBlobId: "blob" };

  it("extracts an image whose metadata job produced a reduced copy", () => {
    expect(classifyForExtraction(photo)).toBe("extract");
  });

  it("makes the tick wait for an image whose metadata job has not run", () => {
    expect(classifyForExtraction({ ...photo, metadata: null, reducedBlobId: null })).toBe("awaitingMetadata");
  });

  it("skips an image the metadata job could not read, because it has no reduced copy", () => {
    expect(
      classifyForExtraction({ ...photo, metadata: { pages: null, error: "mediaUnreadable" }, reducedBlobId: null }),
    ).toBe("skip");
  });

  it.each(["application/pdf", "audio/mpeg", "audio/mp4"])("skips %s, with or without metadata", (mimeType) => {
    expect(classifyForExtraction({ mimeType, metadata: null, reducedBlobId: null })).toBe("skip");
    expect(classifyForExtraction({ mimeType, metadata: { pages: null }, reducedBlobId: null })).toBe("skip");
  });
});
