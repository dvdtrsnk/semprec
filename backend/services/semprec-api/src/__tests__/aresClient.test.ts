import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARES_BASE_URL,
  ARES_MAX_RESPONSE_BYTES,
  ARES_TIMEOUT_MS,
  AresLookupError,
  createAresHttpClient,
} from "../aresClient.js";

// Issue gh-1989: the ARES client against a stubbed `fetch`; nothing here reaches the network.

const ICO = "27419363";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** A `fetch` that records its calls and answers each with `respond`. */
function stubFetch(respond: (signal: AbortSignal | null | undefined) => Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    calls.push({ url: requestUrl(input), init });
    return respond(init?.signal);
  };
  return { fetch: fetchStub, calls };
}

function answer(body: unknown, status = 200): () => Promise<Response> {
  return async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

/** The failure of a lookup that is expected to fail with an `AresLookupError`. */
async function failureOf(promise: Promise<unknown>): Promise<AresLookupError> {
  const error: unknown = await promise.then(
    () => undefined,
    (rejected: unknown) => rejected,
  );
  if (!(error instanceof AresLookupError)) throw new Error("The lookup was expected to fail with an AresLookupError");
  return error;
}

/** A stream that errors when `signal` aborts, as the body of an aborted `fetch` does. */
function streamEndingWithAbort(signal: AbortSignal | null | undefined, first?: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (first) controller.enqueue(first);
      signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createAresHttpClient (issue gh-1989)", () => {
  it("asks ARES for the company by its number and returns the registered name, trimmed, ignoring the other fields", async () => {
    const { fetch, calls } = stubFetch(
      answer({ ico: ICO, obchodniJmeno: "  BRAINZ s.r.o.  ", sidlo: { nazevObce: "Praha" }, dic: "CZ27419363" }),
    );

    const company = await createAresHttpClient({ fetch }).lookupCompanyByIco(ICO);

    expect(company).toEqual({ ico: ICO, name: "BRAINZ s.r.o." });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${ARES_BASE_URL}/ekonomicke-subjekty/${ICO}`);
    expect(ARES_BASE_URL).toBe("https://ares.gov.cz/ekonomicke-subjekty-v-be/rest");
    expect(calls[0]?.init).toMatchObject({ method: "GET", redirect: "error" });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null for a 404 and releases the body", async () => {
    const cancel = vi.fn();
    const { fetch } = stubFetch(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 404 }));

    await expect(createAresHttpClient({ fetch }).lookupCompanyByIco(ICO)).resolves.toBeNull();

    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([400, 403, 429, 500, 503])("throws a status failure for a %i and releases the body", async (status) => {
    const cancel = vi.fn();
    const { fetch } = stubFetch(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status }));

    const error = await failureOf(createAresHttpClient({ fetch }).lookupCompanyByIco(ICO));

    expect(error).toMatchObject({ reason: "status", status });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("throws a network failure when the request fails before an answer, keeping the cause and none of the content", async () => {
    const cause = new TypeError("fetch failed");
    const { fetch } = stubFetch(async () => {
      throw cause;
    });

    const error = await failureOf(createAresHttpClient({ fetch }).lookupCompanyByIco(ICO));

    expect(error.reason).toBe("network");
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain(ICO);
  });

  it("throws a network failure when the body stream fails before the deadline", async () => {
    const { fetch } = stubFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200 },
        ),
    );

    expect((await failureOf(createAresHttpClient({ fetch }).lookupCompanyByIco(ICO))).reason).toBe("network");
  });

  describe("deadline", () => {
    it("aborts the request after the deadline and throws a timeout", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { fetch } = stubFetch(
        (signal) =>
          new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            });
          }),
      );
      const lookup = failureOf(createAresHttpClient({ fetch }).lookupCompanyByIco(ICO));

      await vi.advanceTimersByTimeAsync(ARES_TIMEOUT_MS - 1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      expect((await lookup).reason).toBe("timeout");
      expect(ARES_TIMEOUT_MS).toBe(3000);
    });

    it("also bounds the reading of a body that stalls after its headers and throws a timeout", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { fetch } = stubFetch(
        async (signal) =>
          new Response(streamEndingWithAbort(signal, new TextEncoder().encode('{"ico":"2741')), { status: 200 }),
      );
      const lookup = failureOf(createAresHttpClient({ fetch }).lookupCompanyByIco(ICO));

      await vi.advanceTimersByTimeAsync(ARES_TIMEOUT_MS);

      expect((await lookup).reason).toBe("timeout");
    });

    it("clears its timer after an answer, whether it parsed or not", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const hit = stubFetch(answer({ ico: ICO, obchodniJmeno: "BRAINZ s.r.o." }));
      await createAresHttpClient({ fetch: hit.fetch }).lookupCompanyByIco(ICO);
      expect(vi.getTimerCount()).toBe(0);

      const notFound = stubFetch(answer("{}", 404));
      await createAresHttpClient({ fetch: notFound.fetch }).lookupCompanyByIco(ICO);
      expect(vi.getTimerCount()).toBe(0);

      const broken = stubFetch(answer("<html>"));
      await failureOf(createAresHttpClient({ fetch: broken.fetch }).lookupCompanyByIco(ICO));
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("response size cap", () => {
    it("throws a too-large failure and cancels the stream when the body outgrows the cap, without reading on", async () => {
      const cancel = vi.fn();
      let pulls = 0;
      const chunk = new Uint8Array(ARES_MAX_RESPONSE_BYTES / 2 + 1).fill(120);
      const { fetch } = stubFetch(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls++;
                controller.enqueue(chunk);
              },
              cancel,
            }),
            { status: 200 },
          ),
      );

      expect((await failureOf(createAresHttpClient({ fetch }).lookupCompanyByIco(ICO))).reason).toBe("tooLarge");

      expect(cancel).toHaveBeenCalledOnce();
      expect(pulls).toBeLessThanOrEqual(3);
    });

    it("reads a body of exactly the cap", async () => {
      const padding = "x".repeat(
        ARES_MAX_RESPONSE_BYTES - JSON.stringify({ ico: ICO, obchodniJmeno: "A", pad: "" }).length,
      );
      const body = JSON.stringify({ ico: ICO, obchodniJmeno: "A", pad: padding });
      expect(Buffer.byteLength(body)).toBe(ARES_MAX_RESPONSE_BYTES);
      const { fetch } = stubFetch(answer(body));

      await expect(createAresHttpClient({ fetch }).lookupCompanyByIco(ICO)).resolves.toEqual({ ico: ICO, name: "A" });
    });
  });

  describe("an answer that does not match", () => {
    it.each([
      ["a body that is not JSON", "<html>no</html>"],
      ["an empty body", ""],
      ["JSON of another shape", ["BRAINZ"]],
      ["no registered name", { ico: ICO }],
      ["a registered name that is not a string", { ico: ICO, obchodniJmeno: 7 }],
      ["a registered name that is blank", { ico: ICO, obchodniJmeno: "   " }],
      ["a registered name over 500 characters", { ico: ICO, obchodniJmeno: "n".repeat(501) }],
      ["no number", { obchodniJmeno: "BRAINZ s.r.o." }],
      ["the number of another company", { ico: "45274649", obchodniJmeno: "OTHER a.s." }],
    ])("throws a malformed failure for %s", async (_label, body) => {
      const { fetch } = stubFetch(answer(body));

      const error = await failureOf(createAresHttpClient({ fetch }).lookupCompanyByIco(ICO));

      expect(error.reason).toBe("malformed");
      expect(error.message).not.toContain("BRAINZ");
    });

    it("throws a malformed failure for a 200 without a body", async () => {
      const { fetch } = stubFetch(async () => new Response(null, { status: 200 }));

      expect((await failureOf(createAresHttpClient({ fetch }).lookupCompanyByIco(ICO))).reason).toBe("malformed");
    });
  });

  describe("the number", () => {
    it.each([["1234567"], ["123456789"], ["abcdefgh"], [""], ["../x"], ["2741936 "], ["27419363/../x"]])(
      "refuses %j without sending a request",
      async (ico) => {
        const { fetch, calls } = stubFetch(answer({ ico, obchodniJmeno: "X" }));

        expect((await failureOf(createAresHttpClient({ fetch }).lookupCompanyByIco(ico))).reason).toBe("invalidIco");

        expect(calls).toEqual([]);
      },
    );

    it("accepts a number that starts with zeros", async () => {
      const { fetch, calls } = stubFetch(answer({ ico: "00006947", obchodniJmeno: "Ministerstvo financí" }));

      await expect(createAresHttpClient({ fetch }).lookupCompanyByIco("00006947")).resolves.toEqual({
        ico: "00006947",
        name: "Ministerstvo financí",
      });
      expect(calls[0]?.url.endsWith("/ekonomicke-subjekty/00006947")).toBe(true);
    });
  });
});
