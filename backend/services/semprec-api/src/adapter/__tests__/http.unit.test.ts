import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { ValidationError } from "@semprec/data";
import { describe, expect, it } from "vitest";
import { PayloadTooLargeError, extractBearerToken, readJsonBody, readRawBody, sendJson } from "../http.js";

function fakeRequest(body: string | Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const readable = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  Object.assign(readable, { headers });
  return readable as unknown as IncomingMessage;
}

interface RecordedResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

function fakeResponse(): { res: ServerResponse; recorded: RecordedResponse } {
  const recorded: RecordedResponse = {};
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      recorded.status = status;
      recorded.headers = headers;
      return res;
    },
    end(payload: string) {
      recorded.body = payload;
    },
  } as unknown as ServerResponse;
  return { res, recorded };
}

describe("sendJson", () => {
  it("writes the status, the JSON content type, no-store and the merged extra headers", () => {
    const { res, recorded } = fakeResponse();
    sendJson(res, 201, { ok: true }, { "Set-Cookie": "a=b" });
    expect(recorded.status).toBe(201);
    expect(recorded.headers).toEqual({
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "a=b",
      "Cache-Control": "no-store",
    });
    expect(recorded.body).toBe(JSON.stringify({ ok: true }));
  });

  it("sets Cache-Control: no-store when the caller passes no headers", () => {
    const { res, recorded } = fakeResponse();
    sendJson(res, 200, {});
    expect(recorded.headers?.["Cache-Control"]).toBe("no-store");
  });

  it("overrides a caller-supplied Cache-Control", () => {
    const { res, recorded } = fakeResponse();
    sendJson(res, 200, {}, { "Cache-Control": "max-age=60" });
    expect(recorded.headers?.["Cache-Control"]).toBe("no-store");
  });
});

describe("readJsonBody", () => {
  it("returns {} for an empty body", async () => {
    await expect(readJsonBody(fakeRequest(""), { maxBytes: 1024 })).resolves.toEqual({});
  });

  it("returns the parsed value for valid JSON", async () => {
    await expect(readJsonBody(fakeRequest('{"a":1}'), { maxBytes: 1024 })).resolves.toEqual({ a: 1 });
  });

  it("throws ValidationError for malformed JSON", async () => {
    await expect(readJsonBody(fakeRequest("{not json"), { maxBytes: 1024 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws PayloadTooLargeError when the body exceeds maxBytes by one byte", async () => {
    await expect(readJsonBody(fakeRequest("12345"), { maxBytes: 4 })).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("resolves at exactly maxBytes", async () => {
    await expect(readJsonBody(fakeRequest("1234"), { maxBytes: 4 })).resolves.toBe(1234);
  });
});

describe("readRawBody", () => {
  it("returns the concatenated bytes", async () => {
    const buf = await readRawBody(fakeRequest("hello world"), { maxBytes: 1024 });
    expect(buf.toString("utf8")).toBe("hello world");
  });
});

describe("extractBearerToken", () => {
  it("returns null for no header", () => {
    expect(extractBearerToken(fakeRequest(""))).toBeNull();
  });

  it("returns null for a Basic auth header", () => {
    expect(extractBearerToken(fakeRequest("", { authorization: "Basic x" }))).toBeNull();
  });

  it("returns null for a Bearer header with spaces only", () => {
    expect(extractBearerToken(fakeRequest("", { authorization: "Bearer  " }))).toBeNull();
  });

  it("returns the trimmed token for a Bearer header with surrounding whitespace", () => {
    expect(extractBearerToken(fakeRequest("", { authorization: "Bearer  abc " }))).toBe("abc");
  });
});
