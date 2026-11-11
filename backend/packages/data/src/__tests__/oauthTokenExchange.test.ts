import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { exchangeAuthorizationCode, MICROSOFT_TOKEN_URL, refreshAccessToken } from "../mail/oauthTokenExchange.js";
import {
  MailAdminConsentRequiredError,
  MailAuthorizationCodeRejectedError,
  MailReauthorizationRequiredError,
} from "../mail/providerTypes.js";
import { logger } from "../mail/logger.js";

const SENTINELS = {
  code: "SENTINEL-CODE-1",
  codeVerifier: "SENTINEL-VERIFIER-2",
  clientSecret: "SENTINEL-SECRET-3",
};
const input = {
  tokenUrl: MICROSOFT_TOKEN_URL,
  clientId: "client-id",
  redirectUri: "https://app.example/callback",
  ...SENTINELS,
};

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
  throw new Error("expected rejection");
}

function expectNoSecrets(error: Error) {
  const text = `${error.message} ${String(error.stack)} ${JSON.stringify(error)}`;
  for (const value of Object.values(SENTINELS)) expect(text).not.toContain(value);
  expect(text).not.toContain("SENTINEL-ACCESS");
  expect(text).not.toContain("SENTINEL-REFRESH");
}

describe("refreshAccessToken bounds", () => {
  const refreshInput = {
    tokenUrl: "https://idp.example/token",
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["undefined", undefined],
    ["secret-bearing object", { secret: "OAUTH-PRIVATE-SENTINEL" }],
  ])("keeps a %s request failure private when diagnostics fail", async (_name, original) => {
    let observed: unknown;
    const fetchImpl: typeof fetch = async () => {
      observed = original;
      // Deliberately exercise non-Error provider rejections.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(original);
    };
    const diagnostic = new Error("OAUTH-PRIVATE-SENTINEL");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {
      throw diagnostic;
    });
    const outcome = await caught(refreshAccessToken({ ...refreshInput, fetchImpl }));
    expect(observed).toBe(original);
    expect(warn).toHaveBeenCalledOnce();
    expect(outcome.message).toBe("OAuth token refresh request failed");
    expect(outcome).not.toHaveProperty("cause");
    expect(`${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain("OAUTH-PRIVATE-SENTINEL");
  });

  it("keeps the reader failure primary when cancellation, release and diagnostics fail", async () => {
    const response = new Response(new ReadableStream<Uint8Array>());
    if (!response.body) throw new Error("Missing response body");
    const reader = response.body.getReader();
    const original = new Error("OAUTH-PRIMARY-PRIVATE-SENTINEL");
    const cleanup = new Error("OAUTH-CLEANUP-PRIVATE-SENTINEL");
    let read: unknown;
    let cancelled: unknown;
    let released: unknown;
    vi.spyOn(reader, "read").mockImplementation(async () => {
      read = original;
      throw original;
    });
    vi.spyOn(reader, "cancel").mockImplementation(async () => {
      cancelled = cleanup;
      throw cleanup;
    });
    const release = reader.releaseLock.bind(reader);
    vi.spyOn(reader, "releaseLock").mockImplementation(() => {
      release();
      released = cleanup;
      throw cleanup;
    });
    vi.spyOn(response.body, "getReader").mockReturnValue(reader);
    vi.spyOn(logger, "warn").mockImplementation(() => {
      throw new Error("OAUTH-DIAGNOSTIC-PRIVATE-SENTINEL");
    });
    const outcome = await caught(refreshAccessToken({ ...refreshInput, fetchImpl: async () => response }));
    expect(read).toBe(original);
    expect(cancelled).toBe(cleanup);
    expect(released).toBe(cleanup);
    expect(outcome.message).toBe("OAuth token refresh response could not be read");
    expect(outcome).not.toHaveProperty("cause");
    expect(`${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain("PRIVATE-SENTINEL");
  });

  it("keeps a genuine 401 classification when body cancellation and diagnostics fail", async () => {
    const cleanup = new Error("OAUTH-CLEANUP-PRIVATE-SENTINEL");
    let observed: unknown;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          observed = cleanup;
          throw cleanup;
        },
      }),
      { status: 401 },
    );
    vi.spyOn(logger, "warn").mockImplementation(() => {
      throw new Error("OAUTH-DIAGNOSTIC-PRIVATE-SENTINEL");
    });
    const outcome = await caught(refreshAccessToken({ ...refreshInput, fetchImpl: async () => response }));
    expect(observed).toBe(cleanup);
    expect(outcome).toBeInstanceOf(MailReauthorizationRequiredError);
    expect(`${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain("PRIVATE-SENTINEL");
  });

  it("sanitizes release failure after a successful body read", async () => {
    const response = new Response('{"access_token":"a","expires_in":60}');
    if (!response.body) throw new Error("Missing response body");
    const reader = response.body.getReader();
    const release = reader.releaseLock.bind(reader);
    const failure = new Error("OAUTH-RELEASE-PRIVATE-SENTINEL");
    let observed: unknown;
    vi.spyOn(reader, "releaseLock").mockImplementation(() => {
      release();
      observed = failure;
      throw failure;
    });
    vi.spyOn(response.body, "getReader").mockReturnValue(reader);
    const outcome = await caught(refreshAccessToken({ ...refreshInput, fetchImpl: async () => response }));
    expect(observed).toBe(failure);
    expect(outcome.message).toBe("OAuth token refresh response could not be released");
    expect(outcome).not.toHaveProperty("cause");
    expect(`${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain("PRIVATE-SENTINEL");
  });

  it("rejects a response larger than 64 KiB", async () => {
    const fetchImpl: typeof fetch = async () => new Response("x".repeat(65_537));
    await expect(refreshAccessToken({ ...refreshInput, fetchImpl })).rejects.toThrow("exceeds the size limit");
  });

  it("accepts a JSON response exactly 64 KiB long", async () => {
    const prefix = '{"access_token":"access","expires_in":60,"padding":"';
    const suffix = '"}';
    const payload = prefix + "x".repeat(65_536 - prefix.length - suffix.length) + suffix;
    const fetchImpl: typeof fetch = async () => new Response(payload);
    await expect(refreshAccessToken({ ...refreshInput, fetchImpl })).resolves.toMatchObject({ accessToken: "access" });
  });

  it("aborts an unfinished request at 15 seconds", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchImpl: typeof fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("cancelled"));
        });
      });
    const outcome = refreshAccessToken({ ...refreshInput, fetchImpl });
    const assertion = expect(outcome).rejects.toThrow("OAuth token refresh request failed");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(aborted).toBe(true);
  });

  it("aborts an unfinished response body at the same deadline", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchImpl: typeof fetch = async (_url, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              controller.error(new Error("cancelled"));
            });
          },
        }),
      );
    const outcome = refreshAccessToken({ ...refreshInput, fetchImpl });
    const assertion = expect(outcome).rejects.toThrow("OAuth token refresh response could not be read");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(aborted).toBe(true);
  });

  it("closes an actual stalled HTTP response when the whole-request deadline expires", async () => {
    const sockets = new Set<Socket>();
    const socketClosures: Promise<void>[] = [];
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"access_token":');
      response.on("close", resolveClosed);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socketClosures.push(
        new Promise<void>((resolve) =>
          socket.on("close", () => {
            sockets.delete(socket);
            resolve();
          }),
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port");
      await expect(
        refreshAccessToken({ ...refreshInput, tokenUrl: `http://127.0.0.1:${address.port}/token` }),
      ).rejects.toThrow("OAuth token refresh response could not be read");
      await closed;
      await Promise.all(socketClosures);
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 20_000);
});

describe("exchangeAuthorizationCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns tokens and posts the authorization_code grant with the PKCE verifier", async () => {
    const fetchMock = mockFetch(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 });
    const before = Date.now();
    const result = await exchangeAuthorizationCode(input);
    expect(result.accessToken).toBe("at");
    expect(result.refreshToken).toBe("rt");
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(MICROSOFT_TOKEN_URL);
    const params = init.body as URLSearchParams;
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code_verifier")).toBe(SENTINELS.codeVerifier);
    expect(params.get("code")).toBe(SENTINELS.code);
    expect(params.get("redirect_uri")).toBe(input.redirectUri);
    expect(params.get("client_id")).toBe("client-id");
    expect(params.get("client_secret")).toBe(SENTINELS.clientSecret);
  });

  it("sends the token request through an injected fetch and never the global one (issue gh-1686)", async () => {
    const globalFetch = mockFetch(500, {});
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const verifier = init?.body instanceof URLSearchParams ? init.body.get("code_verifier") : null;
      requested.push(`${init?.method} ${typeof url === "string" ? url : "not a string"} ${verifier}`);
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 60 }));
    };

    const result = await exchangeAuthorizationCode({ ...input, fetchImpl });

    expect(result).toMatchObject({ accessToken: "at", refreshToken: "rt" });
    expect(requested).toEqual([`POST ${MICROSOFT_TOKEN_URL} ${SENTINELS.codeVerifier}`]);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["refresh token", { access_token: "SENTINEL-ACCESS", expires_in: 3600 }],
    ["access token", { refresh_token: "SENTINEL-REFRESH", expires_in: 3600 }],
    ["numeric expires_in", { access_token: "SENTINEL-ACCESS", refresh_token: "SENTINEL-REFRESH", expires_in: "3600" }],
    ["empty refresh token", { access_token: "SENTINEL-ACCESS", refresh_token: "", expires_in: 3600 }],
  ])("throws when the response lacks %s", async (_name, body) => {
    mockFetch(200, body);
    expectNoSecrets(await caught(exchangeAuthorizationCode(input)));
  });

  it("throws when the response is not an object", async () => {
    mockFetch(200, "[]");
    await expect(exchangeAuthorizationCode(input)).rejects.toThrow();
  });

  it.each([400, 401])("maps %i to the code-rejected error with the provider code only", async (status) => {
    mockFetch(status, {
      error: "invalid_grant",
      error_description: `bad ${SENTINELS.code} ${SENTINELS.codeVerifier} ${SENTINELS.clientSecret}`,
    });
    const error = await caught(exchangeAuthorizationCode(input));
    expect(error).toBeInstanceOf(MailAuthorizationCodeRejectedError);
    expect(error).not.toBeInstanceOf(MailAdminConsentRequiredError);
    expect((error as MailAuthorizationCodeRejectedError).providerError).toBe("invalid_grant");
    expect(error.message).toContain(`status ${status}`);
    expectNoSecrets(error);
  });

  it("classifies consent_required and AADSTS admin-consent invalid_grant as admin consent", async () => {
    mockFetch(400, { error: "consent_required", error_description: "AADSTS65001" });
    const first = await caught(exchangeAuthorizationCode(input));
    expect(first).toBeInstanceOf(MailAdminConsentRequiredError);
    expectNoSecrets(first);

    mockFetch(400, { error: "invalid_grant", error_description: "AADSTS90094: admin approval needed" });
    expect(await caught(exchangeAuthorizationCode(input))).toBeInstanceOf(MailAdminConsentRequiredError);
  });

  it("drops a provider error field that is not a short code and tolerates a non-JSON body", async () => {
    mockFetch(400, { error: `leaked ${SENTINELS.code}` });
    const first = await caught(exchangeAuthorizationCode(input));
    expect(first).toBeInstanceOf(MailAuthorizationCodeRejectedError);
    expect((first as MailAuthorizationCodeRejectedError).providerError).toBeNull();
    expectNoSecrets(first);

    mockFetch(401, "<html>nope</html>");
    expect(await caught(exchangeAuthorizationCode(input))).toBeInstanceOf(MailAuthorizationCodeRejectedError);
  });

  it.each([200, 400, 401])("bounds and cancels an oversized authorization response with status %s", async (status) => {
    let cancelled = false;
    let pulls = 0;
    const bytes = new TextEncoder().encode("x".repeat(65_536));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(pulls++ === 0 ? bytes : new Uint8Array([1]));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status },
          ),
      ),
    );
    const error = await caught(exchangeAuthorizationCode(input));
    expect(cancelled).toBe(true);
    expect(pulls).toBeGreaterThanOrEqual(2);
    if (status === 200) expect(error.message).toBe("OAuth code exchange response could not be read");
    else expect(error).toBeInstanceOf(MailAuthorizationCodeRejectedError);
    expectNoSecrets(error);
  });

  it("releases an unread non-classified error response without exposing cleanup failures", async () => {
    const failure = new Error("SENTINEL-ACCESS");
    let observed: unknown;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          observed = failure;
          throw failure;
        },
      }),
      { status: 503 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const error = await caught(exchangeAuthorizationCode(input));
    expect(observed).toBe(failure);
    expect(error.message).toBe("OAuth code exchange failed with status 503");
    expectNoSecrets(error);
  });

  it.each([200, 400, 503])("logs a safe actual cleanup failure for authorization status %s", async (status) => {
    const cleanup = new Error("SENTINEL-CLEANUP-PRIVATE");
    let observed: unknown;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(pulls++ === 0 ? new Uint8Array(65_536) : new Uint8Array([1]));
      },
      cancel() {
        observed = cleanup;
        throw cleanup;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status })),
    );
    const streamSymbol = Object.getOwnPropertySymbols(logger).find((symbol) => symbol.description === "pino.stream");
    if (!streamSymbol) throw new Error("Missing application logger stream");
    const original: unknown = Reflect.get(logger, streamSymbol);
    const logs: string[] = [];
    if (
      !Reflect.set(logger, streamSymbol, {
        write: (line: string) => {
          logs.push(line);
          return true;
        },
      })
    )
      throw new Error("Could not capture application log stream");
    const failures: unknown[] = [];
    try {
      const outcome = await caught(exchangeAuthorizationCode(input));
      expect(observed).toBe(cleanup);
      if (status === 400) expect(outcome).toBeInstanceOf(MailAuthorizationCodeRejectedError);
      else if (status === 503) expect(outcome.message).toBe("OAuth code exchange failed with status 503");
      else expect(outcome.message).toBe("OAuth code exchange response could not be read");
      expectNoSecrets(outcome);
      expect(outcome).not.toHaveProperty("cause");
      expect(logs).toHaveLength(1);
      const record: unknown = JSON.parse(logs[0] ?? "null");
      expect(record).toMatchObject({ stage: status === 503 ? "response_cancel" : "reader_cancel" });
      expect(logs.join("")).not.toContain("SENTINEL-CLEANUP-PRIVATE");
      for (const secret of Object.values(SENTINELS)) expect(logs.join("")).not.toContain(secret);
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!Reflect.set(logger, streamSymbol, original)) throw new Error("Could not restore application log stream");
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "OAuth diagnostic test and cleanup failed");
  });

  it.each([false, true])(
    "retains ordered read, cancel and release failures when the first diagnostic fails: %s",
    async (failFirstDiagnostic) => {
      const response = new Response(new ReadableStream<Uint8Array>());
      if (!response.body) throw new Error("Missing response body");
      const reader = response.body.getReader();
      const primary = new Error("AUTH-READ-PRIVATE");
      const cancelFailure = new Error("AUTH-CANCEL-PRIVATE");
      const releaseFailure = new Error("AUTH-RELEASE-PRIVATE");
      const diagnosticFailure = new Error("AUTH-DIAGNOSTIC-PRIVATE");
      const observed: Array<{ stage: string; value: unknown }> = [];
      vi.spyOn(reader, "read").mockImplementation(async () => {
        observed.push({ stage: "read", value: primary });
        throw primary;
      });
      vi.spyOn(reader, "cancel").mockImplementation(async () => {
        observed.push({ stage: "cancel", value: cancelFailure });
        throw cancelFailure;
      });
      const release = reader.releaseLock.bind(reader);
      vi.spyOn(reader, "releaseLock").mockImplementation(() => {
        release();
        observed.push({ stage: "release", value: releaseFailure });
        throw releaseFailure;
      });
      vi.spyOn(response.body, "getReader").mockReturnValue(reader);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      if (failFirstDiagnostic)
        vi.spyOn(logger, "error").mockImplementationOnce(() => {
          observed.push({ stage: "diagnostic", value: diagnosticFailure });
          throw diagnosticFailure;
        });
      const streamSymbol = Object.getOwnPropertySymbols(logger).find((symbol) => symbol.description === "pino.stream");
      if (!streamSymbol) throw new Error("Missing application logger stream");
      const previous: unknown = Reflect.get(logger, streamSymbol);
      const logs: string[] = [];
      if (
        !Reflect.set(logger, streamSymbol, {
          write: (line: string) => {
            logs.push(line);
            return true;
          },
        })
      )
        throw new Error("Could not capture application log stream");
      const failures: unknown[] = [];
      try {
        const outcome = await caught(exchangeAuthorizationCode(input));
        expect(outcome.message).toBe("OAuth code exchange response could not be read");
        expect(outcome).not.toHaveProperty("cause");
        const expected = failFirstDiagnostic
          ? [
              { stage: "read", value: primary },
              { stage: "cancel", value: cancelFailure },
              { stage: "diagnostic", value: diagnosticFailure },
              { stage: "release", value: releaseFailure },
            ]
          : [
              { stage: "read", value: primary },
              { stage: "cancel", value: cancelFailure },
              { stage: "release", value: releaseFailure },
            ];
        expect(observed.map((entry) => entry.stage)).toEqual(expected.map((entry) => entry.stage));
        for (let index = 0; index < expected.length; index++)
          expect(observed[index]?.value).toBe(expected[index]?.value);
        const records: unknown[] = logs.map((line): unknown => JSON.parse(line));
        expect(records).toHaveLength(failFirstDiagnostic ? 1 : 2);
        expect(records).toEqual(
          failFirstDiagnostic
            ? [expect.objectContaining({ stage: "reader_release" })]
            : [
                expect.objectContaining({ stage: "reader_cancel" }),
                expect.objectContaining({ stage: "reader_release" }),
              ],
        );
        expect(`${outcome.stack} ${JSON.stringify(outcome)} ${logs.join("")}`).not.toContain("AUTH-READ-PRIVATE");
        expect(logs.join("")).not.toContain("AUTH-CANCEL-PRIVATE");
        expect(logs.join("")).not.toContain("AUTH-RELEASE-PRIVATE");
        expect(logs.join("")).not.toContain("AUTH-DIAGNOSTIC-PRIVATE");
      } catch (error) {
        failures.push(error);
      }
      try {
        if (!Reflect.set(logger, streamSymbol, previous)) throw new Error("Could not restore application log stream");
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "OAuth combined diagnostic test and cleanup failed");
    },
  );

  it("retains the typed rejection when cleanup and diagnostic publication both fail", async () => {
    const cleanup = new Error("SENTINEL-CLEANUP-PRIVATE");
    const diagnostic = new Error("SENTINEL-DIAGNOSTIC-PRIVATE");
    let observed: unknown;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(pulls++ === 0 ? new Uint8Array(65_536) : new Uint8Array([1]));
      },
      cancel() {
        observed = cleanup;
        throw cleanup;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 401 })),
    );
    const log = vi.spyOn(logger, "error").mockImplementation(() => {
      throw diagnostic;
    });
    const outcome = await caught(exchangeAuthorizationCode(input));
    expect(observed).toBe(cleanup);
    expect(log).toHaveBeenCalledOnce();
    expect(outcome).toBeInstanceOf(MailAuthorizationCodeRejectedError);
    expect(outcome).not.toHaveProperty("cause");
    expect(`${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain("SENTINEL-CLEANUP-PRIVATE");
    expect(`${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain("SENTINEL-DIAGNOSTIC-PRIVATE");
    expectNoSecrets(outcome);
  });

  it("retains the primary status when cleanup diagnostics are disabled", async () => {
    const cleanup = new Error("SENTINEL-CLEANUP-PRIVATE");
    let observed: unknown;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        observed = cleanup;
        throw cleanup;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 503 })),
    );
    vi.spyOn(logger, "isLevelEnabled").mockReturnValue(false);
    const log = vi.spyOn(logger, "error");
    const outcome = await caught(exchangeAuthorizationCode(input));
    expect(observed).toBe(cleanup);
    expect(log).not.toHaveBeenCalled();
    expect(outcome.message).toBe("OAuth code exchange failed with status 503");
    expect(`${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain("SENTINEL-CLEANUP-PRIVATE");
  });

  it("safely diagnoses an actual reader release failure without returning a token", async () => {
    const response = new Response('{"access_token":"access","refresh_token":"refresh","expires_in":60}');
    if (!response.body) throw new Error("Missing response body");
    const reader = response.body.getReader();
    const release = reader.releaseLock.bind(reader);
    const cleanup = new Error("SENTINEL-RELEASE-PRIVATE");
    let observed: unknown;
    vi.spyOn(reader, "releaseLock").mockImplementation(() => {
      release();
      observed = cleanup;
      throw cleanup;
    });
    vi.spyOn(response.body, "getReader").mockReturnValue(reader);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const streamSymbol = Object.getOwnPropertySymbols(logger).find((symbol) => symbol.description === "pino.stream");
    if (!streamSymbol) throw new Error("Missing application logger stream");
    const original: unknown = Reflect.get(logger, streamSymbol);
    const logs: string[] = [];
    if (
      !Reflect.set(logger, streamSymbol, {
        write: (line: string) => {
          logs.push(line);
          return true;
        },
      })
    )
      throw new Error("Could not capture application log stream");
    const failures: unknown[] = [];
    try {
      const outcome = await caught(exchangeAuthorizationCode(input));
      expect(observed).toBe(cleanup);
      expect(outcome.message).toBe("OAuth code exchange response could not be read");
      expect(outcome).not.toHaveProperty("cause");
      expect(logs).toHaveLength(1);
      const record: unknown = JSON.parse(logs[0] ?? "null");
      expect(record).toMatchObject({ stage: "reader_release" });
      expect(logs.join("")).not.toContain("SENTINEL-RELEASE-PRIVATE");
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!Reflect.set(logger, streamSymbol, original)) throw new Error("Could not restore application log stream");
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "OAuth diagnostic test and cleanup failed");
  });

  it("accepts an authorization response exactly at the byte limit", async () => {
    const prefix = '{"access_token":"access","refresh_token":"refresh","expires_in":60,"padding":"';
    const suffix = '"}';
    const payload = prefix + "x".repeat(65_536 - prefix.length - suffix.length) + suffix;
    mockFetch(200, payload);
    await expect(exchangeAuthorizationCode(input)).resolves.toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
    });
  });

  it("settles an actual stalled authorization response at the 15-second deadline", async () => {
    const sockets = new Set<Socket>();
    const closed: Promise<void>[] = [];
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"access_token":');
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      closed.push(
        new Promise<void>((resolve) =>
          socket.on("close", () => {
            sockets.delete(socket);
            resolve();
          }),
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const failures: unknown[] = [];
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port");
      const started = Date.now();
      const error = await caught(
        exchangeAuthorizationCode({ ...input, tokenUrl: `http://127.0.0.1:${address.port}/token` }),
      );
      expect(error.message).toBe("OAuth code exchange response could not be read");
      expect(Date.now() - started).toBeGreaterThanOrEqual(14_000);
      expectNoSecrets(error);
      await Promise.all(closed);
      expect(sockets.size).toBe(0);
    } catch (error) {
      failures.push(error);
    }
    for (const socket of sockets) socket.destroy();
    try {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await Promise.all(closed);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Authorization deadline test and cleanup failed");
  }, 20_000);

  it("redacts network errors, malformed JSON, and secret-shaped provider codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`request ${SENTINELS.code} ${SENTINELS.codeVerifier} ${SENTINELS.clientSecret}`);
      }),
    );
    expectNoSecrets(await caught(exchangeAuthorizationCode(input)));

    mockFetch(200, `{"access_token":"SENTINEL-ACCESS", ${SENTINELS.code}`);
    expectNoSecrets(await caught(exchangeAuthorizationCode(input)));

    mockFetch(400, { error: "token_secret" });
    const unknownCode = await caught(exchangeAuthorizationCode(input));
    expect(unknownCode).toBeInstanceOf(MailAuthorizationCodeRejectedError);
    expect(unknownCode.message).not.toContain("token_secret");

    mockFetch(400, { error: "invalid_grant" });
    const overlappingSecret = await caught(exchangeAuthorizationCode({ ...input, clientSecret: "invalid_grant" }));
    expect(overlappingSecret).toBeInstanceOf(MailAuthorizationCodeRejectedError);
    expect(`${overlappingSecret.message} ${JSON.stringify(overlappingSecret)}`).not.toContain("invalid_grant");
  });

  it("throws a plain error carrying only the status for other failures", async () => {
    mockFetch(500, { error: "server_error", error_description: SENTINELS.code });
    const error = await caught(exchangeAuthorizationCode(input));
    expect(error).not.toBeInstanceOf(MailAuthorizationCodeRejectedError);
    expect(error.message).toBe("OAuth code exchange failed with status 500");
    expectNoSecrets(error);
  });
});
