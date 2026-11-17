import { describe, expect, it } from "vitest";
import { addressDomain, domainBelongsToHost, FREEMAIL_DOMAINS, webHost } from "../threadLinkRules.js";

describe("webHost", () => {
  it.each([
    ["https://www.Acme.cz/about?x=1", "acme.cz"],
    ["http://acme.cz:8080/", "acme.cz"],
    ["acme.cz", "acme.cz"],
    ["WWW.ACME.CZ", "acme.cz"],
    ["  https://shop.acme.cz  ", "shop.acme.cz"],
    ["ftp://files.acme.cz/pub", "files.acme.cz"],
  ])("reads the host of %s as %s", (value, host) => {
    expect(webHost(value)).toBe(host);
  });

  it.each([
    [""],
    ["   "],
    ["https://"],
    ["not a host"],
    ["http://exa mple.cz"],
    [null],
    [undefined],
    [42],
    [{ url: "acme.cz" }],
  ])("reads no host from %j", (value) => {
    expect(webHost(value)).toBeNull();
  });
});

describe("domainBelongsToHost", () => {
  it("accepts the host itself and a subdomain of it", () => {
    expect(domainBelongsToHost("acme.cz", "acme.cz")).toBe(true);
    expect(domainBelongsToHost("mail.acme.cz", "acme.cz")).toBe(true);
    expect(domainBelongsToHost("a.b.acme.cz", "acme.cz")).toBe(true);
  });

  it("refuses a parent domain, a sibling and a name that only ends with the host's letters", () => {
    expect(domainBelongsToHost("cz", "acme.cz")).toBe(false);
    expect(domainBelongsToHost("other.cz", "acme.cz")).toBe(false);
    expect(domainBelongsToHost("notacme.cz", "acme.cz")).toBe(false);
    expect(domainBelongsToHost("acme.cz.evil.test", "acme.cz")).toBe(false);
  });
});

describe("addressDomain", () => {
  it("lowercases the domain and drops a leading www.", () => {
    expect(addressDomain("John@Mail.ACME.cz")).toBe("mail.acme.cz");
    expect(addressDomain("john@www.acme.cz")).toBe("acme.cz");
  });

  it("takes the part after the last @ and refuses text without a domain", () => {
    expect(addressDomain('"a@b"@acme.cz')).toBe("acme.cz");
    expect(addressDomain("john")).toBeNull();
    expect(addressDomain("john@")).toBeNull();
    expect(addressDomain("")).toBeNull();
  });
});

describe("FREEMAIL_DOMAINS", () => {
  it("lists every provider the specification names", () => {
    for (const domain of [
      "gmail.com",
      "googlemail.com",
      "outlook.com",
      "hotmail.com",
      "live.com",
      "icloud.com",
      "me.com",
      "yahoo.com",
      "seznam.cz",
      "email.cz",
      "centrum.cz",
      "post.cz",
      "atlas.cz",
      "volny.cz",
      "proton.me",
      "protonmail.com",
    ])
      expect(FREEMAIL_DOMAINS.has(domain), domain).toBe(true);
  });

  it("does not list a company domain", () => {
    expect(FREEMAIL_DOMAINS.has("acme.cz")).toBe(false);
  });
});
