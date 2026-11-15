import { describe, expect, it } from "vitest";
import { RecipeFetchError, fetchCapped, findHttpsUrl, readPage, type FetchCappedOptions } from "../recipePageFetch.js";

// Issue gh-1974: the request for a recipe page and the reading of what came back.

const OPTIONS: FetchCappedOptions = {
  accept: "text/html",
  contentTypes: ["text/html"],
  maxBytes: 1000,
  timeoutMs: 1000,
};

type Fetch = Parameters<typeof fetchCapped>[0];

/** A fetch that answers with `response` and records the request it saw. */
function answering(response: Response): {
  fetch: Fetch;
  requests: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  return {
    requests,
    fetch: (input, init) => {
      requests.push({ url: String(input), init });
      return Promise.resolve(response);
    },
  };
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

/** A body of `text` that notes whether it was cancelled. */
function watchedBody(text: string): { stream: ReadableStream<Uint8Array>; cancelled(): boolean } {
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return { stream, cancelled: () => wasCancelled };
}

/** The reason a request failed with, or a thrown error that is not a `RecipeFetchError`. */
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RecipeFetchError) return error.reason;
    throw error;
  }
  throw new Error("Expected the request to fail");
}

describe("findHttpsUrl", () => {
  it.each([
    ["a bare link", "https://recipes.example.com/goulash", "https://recipes.example.com/goulash"],
    [
      "a link in a sentence",
      "Try https://recipes.example.com/goulash, it is great.",
      "https://recipes.example.com/goulash",
    ],
    ["a link in parentheses", "(see https://recipes.example.com/a?b=1)", "https://recipes.example.com/a?b=1"],
    ["the first of two links", "https://a.example.com/x and https://b.example.com/y", "https://a.example.com/x"],
    ["an upper-case scheme", "HTTPS://recipes.example.com/goulash", "HTTPS://recipes.example.com/goulash"],
    ["a literal host, which the caller refuses", "go to https://127.0.0.1/admin", "https://127.0.0.1/admin"],
  ])("finds %s", (_label, text, expected) => {
    expect(findHttpsUrl(text)).toBe(expected);
  });

  it.each([
    ["no link", "Goulash with dumplings"],
    ["an http link", "http://recipes.example.com/goulash"],
    ["an empty text", ""],
  ])("finds nothing in %s", (_label, text) => {
    expect(findHttpsUrl(text)).toBeNull();
  });
});

describe("readPage", () => {
  it("returns the visible text without tags, scripts and styles, with entities decoded and whitespace collapsed", () => {
    const page = readPage(
      `<html><head><title>Goulash</title><style>p { color: red }</style><script>var secret = 1;</script></head>
       <body><h1>Goulash &amp; dumplings</h1>

       <p>500 g beef &lt;chuck&gt;</p><script type="application/ld+json">{"name":"x"}</script></body></html>`,
      "https://recipes.example.com/goulash",
    );

    expect(page.text).toBe("Goulash Goulash & dumplings 500 g beef <chuck>");
    expect(page.imageUrl).toBeNull();
  });

  it("cuts the text at 30000 characters", () => {
    const page = readPage(`<p>${"x".repeat(40_000)}</p>`, "https://recipes.example.com/");

    expect(page.text).toHaveLength(30_000);
  });

  it.each([
    [
      "an absolute URL",
      `<meta property="og:image" content="https://cdn.example.com/a.jpg">`,
      "https://cdn.example.com/a.jpg",
    ],
    [
      "a path resolved against the page",
      `<meta property="og:image" content="/img/a.jpg">`,
      "https://recipes.example.com/img/a.jpg",
    ],
    [
      "the content before the property",
      `<meta content="https://cdn.example.com/b.jpg" property="og:image" />`,
      "https://cdn.example.com/b.jpg",
    ],
    [
      "single quotes",
      `<meta property='og:image' content='https://cdn.example.com/c.jpg'>`,
      "https://cdn.example.com/c.jpg",
    ],
    [
      "an escaped ampersand",
      `<meta property="og:image" content="https://cdn.example.com/d.jpg?a=1&amp;b=2">`,
      "https://cdn.example.com/d.jpg?a=1&b=2",
    ],
  ])("reads the og:image tag with %s", (_label, tag, expected) => {
    expect(readPage(`<head>${tag}</head><p>x</p>`, "https://recipes.example.com/goulash/").imageUrl).toBe(expected);
  });

  it("skips a meta tag of another property and an og:image tag without content, and takes the next one", () => {
    const page = readPage(
      `<meta property="og:title" content="Goulash"><meta property="og:image"><meta property="og:image" content="  ">
       <meta property="og:image" content="https://cdn.example.com/e.jpg">`,
      "https://recipes.example.com/",
    );

    expect(page.imageUrl).toBe("https://cdn.example.com/e.jpg");
  });

  it("skips an og:image content that is not a URL against the page and finds none when no tag is left", () => {
    // `new URL` refuses a relative reference against a base that is not a URL.
    expect(readPage(`<meta property="og:image" content="/a.jpg">`, "not a base").imageUrl).toBeNull();
  });
});

describe("fetchCapped", () => {
  it("returns the body and the media type, and sends a GET with the accept header and a signal", async () => {
    const { fetch, requests } = answering(html("<p>hello</p>"));

    const result = await fetchCapped(fetch, "https://recipes.example.com/goulash", OPTIONS);

    expect(result.bytes.toString("utf8")).toBe("<p>hello</p>");
    expect(result.contentType).toBe("text/html");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://recipes.example.com/goulash");
    expect(requests[0]?.init).toMatchObject({ method: "GET", headers: { accept: "text/html" } });
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts a body exactly at the cap and one with no body", async () => {
    const atCap = await fetchCapped(answering(html("x".repeat(1000))).fetch, "https://r.example.com/", OPTIONS);
    const empty = await fetchCapped(
      answering(new Response(null, { status: 204, headers: { "content-type": "text/html" } })).fetch,
      "https://r.example.com/",
      OPTIONS,
    );

    expect(atCap.bytes).toHaveLength(1000);
    expect(empty.bytes).toHaveLength(0);
  });

  it("refuses a status outside 2xx and releases the body", async () => {
    const watched = watchedBody("gone");
    const response = new Response(watched.stream, { status: 404, headers: { "content-type": "text/html" } });

    expect(await failureOf(fetchCapped(answering(response).fetch, "https://r.example.com/", OPTIONS))).toBe("status");
    expect(watched.cancelled()).toBe(true);
  });

  it.each([
    ["a media type outside the list", "application/pdf"],
    ["no media type", ""],
  ])("refuses %s", async (_label, contentType) => {
    const response = new Response("%PDF", {
      status: 200,
      headers: contentType === "" ? {} : { "content-type": contentType },
    });

    expect(await failureOf(fetchCapped(answering(response).fetch, "https://r.example.com/", OPTIONS))).toBe(
      "contentType",
    );
  });

  it("refuses a Content-Length over the cap and releases the body unread", async () => {
    const watched = watchedBody("small");
    const response = new Response(watched.stream, {
      status: 200,
      headers: { "content-type": "text/html", "content-length": "1001" },
    });

    expect(await failureOf(fetchCapped(answering(response).fetch, "https://r.example.com/", OPTIONS))).toBe("tooLarge");
    expect(watched.cancelled()).toBe(true);
  });

  it("stops reading a body that grows past the cap with no Content-Length", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(400));
        if (pulled === 100) controller.close();
      },
    });
    const response = new Response(stream, { status: 200, headers: { "content-type": "text/html" } });

    expect(await failureOf(fetchCapped(answering(response).fetch, "https://r.example.com/", OPTIONS))).toBe("tooLarge");
    // 400 bytes per chunk against a cap of 1000: the third chunk crosses it, and the stream is not drained.
    expect(pulled).toBeLessThan(10);
  });

  it("reports a failure of the request itself as unreachable, keeping the cause", async () => {
    const cause = new TypeError("fetch failed");
    const fetch: Fetch = () => Promise.reject(cause);

    const error = await fetchCapped(fetch, "https://r.example.com/", OPTIONS).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RecipeFetchError);
    expect(error).toMatchObject({ reason: "unreachable", cause });
  });

  it("reports a request that outlasts the deadline as a timeout", async () => {
    const fetch: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });

    expect(await failureOf(fetchCapped(fetch, "https://r.example.com/", { ...OPTIONS, timeoutMs: 20 }))).toBe(
      "timeout",
    );
  });

  it("reports a body that stalls past the deadline as a timeout, and one that errors as unreachable", async () => {
    // Like a real response, the body of the stalled one fails with the abort of the request's signal.
    const stalled: Fetch = (_input, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
          { status: 200, headers: { "content-type": "text/html" } },
        ),
      );
    const broken = answering(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ).fetch;

    expect(await failureOf(fetchCapped(stalled, "https://r.example.com/", { ...OPTIONS, timeoutMs: 20 }))).toBe(
      "timeout",
    );
    expect(await failureOf(fetchCapped(broken, "https://r.example.com/", OPTIONS))).toBe("unreachable");
  });

  it("refuses a body made of something other than bytes and releases it", async () => {
    let cancelled = false;
    const response = new Response(null, { status: 200, headers: { "content-type": "text/html" } });
    // A body whose reader yields a string: `Response` cannot be built from one, so the stand-in replaces the body.
    Object.defineProperty(response, "body", {
      value: {
        getReader: () => ({
          read: () => Promise.resolve({ done: false, value: "text, not bytes" }),
          cancel: () => {
            cancelled = true;
            return Promise.resolve();
          },
        }),
      },
    });

    expect(await failureOf(fetchCapped(answering(response).fetch, "https://r.example.com/", OPTIONS))).toBe(
      "unreachable",
    );
    expect(cancelled).toBe(true);
  });
});
