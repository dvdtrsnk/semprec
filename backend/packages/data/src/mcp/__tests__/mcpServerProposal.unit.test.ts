import { describe, expect, it } from "vitest";
import { normalizeMcpServerProperties } from "../mcpServerProposal.js";

describe("normalizeMcpServerProperties (issue #1934)", () => {
  const URL_ = "https://mcp.example.com/mcp";

  it.each(["http", "sse"])("keeps only the transport and the url of a %s connection", (transport) => {
    const properties = {
      name: "Remote tool",
      active: true,
      connectionConfig: { transport, url: URL_, command: "my-mcp-server", args: ["--x"], env: { LOG_LEVEL: "debug" } },
    };

    expect(normalizeMcpServerProperties(properties)).toEqual({
      name: "Remote tool",
      active: true,
      connectionConfig: { transport, url: URL_ },
    });
  });

  it("does not change the properties it was given", () => {
    const properties = { name: "Remote tool", connectionConfig: { transport: "http", url: URL_, command: "x" } };

    normalizeMcpServerProperties(properties);

    expect(properties.connectionConfig).toEqual({ transport: "http", url: URL_, command: "x" });
  });

  it("returns a card with no connection yet as it is", () => {
    const properties = { name: "Remote tool" };

    expect(normalizeMcpServerProperties(properties)).toBe(properties);
  });

  it("returns a stdio connection as it is, which confirm refuses before it gets here", () => {
    const properties = { name: "Local tool", connectionConfig: { transport: "stdio", command: "my-mcp-server" } };

    expect(normalizeMcpServerProperties(properties)).toBe(properties);
  });

  it("returns a connection that does not parse as it is", () => {
    const properties = { name: "Bad", connectionConfig: { transport: "http" } };

    expect(normalizeMcpServerProperties(properties)).toBe(properties);
  });
});
