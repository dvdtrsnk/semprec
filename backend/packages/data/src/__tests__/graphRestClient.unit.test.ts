import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphRestClient } from "../mail/graphRestClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Graph flag write-back", () => {
  it("patches the message resource with the requested flag state", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GraphRestClient(async () => "test-token");

    await client.patchMessage("message/1", { flag: { flagStatus: "flagged" } });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/me/messages/message%2F1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ flag: { flagStatus: "flagged" } }) }),
    );
  });

  it("leaves flags undefined for an old delta link that omits isRead", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          value: [{ id: "message-1", internetMessageId: "<message-1@example.com>", flag: { flagStatus: "flagged" } }],
          "@odata.deltaLink": "https://graph.example/delta-next",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GraphRestClient(async () => "test-token");

    const delta = await client.fetchDelta("https://graph.example/old-delta");

    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({ id: "message-1", removed: false });
    expect(delta.changes[0]?.removed ? undefined : delta.changes[0]?.message.flags).toBeUndefined();
  });
});
