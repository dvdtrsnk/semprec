import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeAuthorizationCode, MICROSOFT_TOKEN_URL, refreshAccessToken } from "../mail/oauthTokenExchange.js";
import { MailAdminConsentRequiredError, MailAuthorizationCodeRejectedError } from "../mail/providerTypes.js";

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
    return error as Error;
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

  afterEach(() => vi.useRealTimers());

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
});

describe("exchangeAuthorizationCode", () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it("throws a plain error carrying only the status for other failures", async () => {
    mockFetch(500, { error: "server_error", error_description: SENTINELS.code });
    const error = await caught(exchangeAuthorizationCode(input));
    expect(error).not.toBeInstanceOf(MailAuthorizationCodeRejectedError);
    expect(error.message).toBe("OAuth code exchange failed with status 500");
    expectNoSecrets(error);
  });
});
