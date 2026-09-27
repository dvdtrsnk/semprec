import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors.js";
import { validateWebPushEndpoint } from "../webPushEndpointValidation.js";

describe("validateWebPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/QAbc",
    "https://push.example:443/x",
  ])("accepts %s and returns it unchanged", (endpoint) => {
    expect(validateWebPushEndpoint(endpoint)).toBe(endpoint);
  });

  it.each([
    "http://push.example/1",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://10.0.0.1/x",
    "https://169.254.169.254/latest",
    "https://[::ffff:127.0.0.1]/x",
    "https://2130706433/x",
    "https://localhost/x",
    "https://localhost./x",
    "https://api.localhost/x",
    "https://api.localhost./x",
    "https://user:pw@push.example/x",
    "https://push.example:9000/x",
    "not a url",
  ])("rejects %s with a ValidationError on the endpoint field", (endpoint) => {
    let thrown: unknown;
    try {
      validateWebPushEndpoint(endpoint);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).details).toEqual({ field: "endpoint" });
    expect((thrown as ValidationError).message).toBe(
      "'endpoint' must be an https URL to a public push service host on port 443, without credentials",
    );
  });
});
