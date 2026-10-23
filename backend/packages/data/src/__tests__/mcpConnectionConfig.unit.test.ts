import { describe, expect, it } from "vitest";
import { assertValidMcpConnectionConfig } from "../mcp/mcpConnectionConfig.js";

/** A stdio config with one env entry, so each case only varies the name under test. */
function stdioWithEnvName(name: string) {
  return { transport: "stdio", command: "my-server", env: { [name]: "value" } };
}

describe("stdio connectionConfig env names (issue #1033)", () => {
  it.each(["API_BASE", "MCP_CONTRACT_CREDENTIAL_ENV_VAR", "GITHUB_TOKEN", "_PRIVATE", "lowercase1"])(
    "accepts the ordinary env name %s",
    (name) => {
      expect(() => assertValidMcpConnectionConfig(stdioWithEnvName(name))).not.toThrow();
    },
  );

  it.each([
    "PATH",
    "HOME",
    "LOGNAME",
    "SHELL",
    "TERM",
    "USER",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "PYTHONSTARTUP",
    "PERL5OPT",
    "PERL5LIB",
    "RUBYOPT",
    "RUBYLIB",
    "BASH_ENV",
    "ENV",
    "SHELLOPTS",
    "GCONV_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
  ])("refuses the forbidden env name %s", (name) => {
    expect(() => assertValidMcpConnectionConfig(stdioWithEnvName(name))).toThrow();
  });

  it.each(["A=B", "API-BASE", "1LEADING_DIGIT", "HAS SPACE", ""])("refuses the malformed env name %j", (name) => {
    expect(() => assertValidMcpConnectionConfig(stdioWithEnvName(name))).toThrow();
  });

  it.each(["PATH", "LD_PRELOAD", "NODE_OPTIONS", "DYLD_LIBRARY_PATH", "bad-name"])(
    "refuses the forbidden credentialEnvVar %s",
    (credentialEnvVar) => {
      expect(() =>
        assertValidMcpConnectionConfig({ transport: "stdio", command: "my-server", credentialEnvVar }),
      ).toThrow();
    },
  );

  it("accepts an ordinary credentialEnvVar", () => {
    expect(() =>
      assertValidMcpConnectionConfig({ transport: "stdio", command: "my-server", credentialEnvVar: "API_KEY" }),
    ).not.toThrow();
  });

  it("leaves sse and http configs unaffected by the env name rule", () => {
    expect(() => assertValidMcpConnectionConfig({ transport: "sse", url: "https://example.com/sse" })).not.toThrow();
    expect(() => assertValidMcpConnectionConfig({ transport: "http", url: "https://example.com/mcp" })).not.toThrow();
  });
});
