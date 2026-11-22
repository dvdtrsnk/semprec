import type { MessageStructureObject } from "imapflow";
import { describe, expect, it } from "vitest";
import { bodyPartPrefixInText, decodeBodyPartPrefix } from "../imapSnippet.js";

const latin1 = (text: string) => Buffer.from(text, "latin1");

describe("decodeBodyPartPrefix", () => {
  it.each([
    { name: "a 7bit UTF-8 part", raw: Buffer.from("Dobrý den"), encoding: "7bit", charset: "utf-8", text: "Dobrý den" },
    {
      name: "a part cut inside a UTF-8 character",
      raw: Buffer.from("Dobrý").subarray(0, 5),
      encoding: "8bit",
      charset: "utf-8",
      text: "Dobr",
    },
    {
      name: "a base64 part cut inside a group, with line breaks",
      raw: latin1(
        `${Buffer.from("Hello there").toString("base64").slice(0, 8)}\r\n${Buffer.from("Hello there").toString("base64").slice(8, 10)}`,
      ),
      encoding: "base64",
      charset: "utf-8",
      text: "Hello ",
    },
    {
      name: "a quoted-printable part with a soft break, an escape and a cut escape",
      raw: latin1("Dobr=C3=BD =\r\nden=C3"),
      encoding: "quoted-printable",
      charset: "utf-8",
      text: "Dobrý den",
    },
    {
      name: "a quoted-printable part cut after the escape sign",
      raw: latin1("caf=C3=A9="),
      encoding: "QUOTED-PRINTABLE",
      charset: "utf-8",
      text: "café",
    },
    {
      name: "a windows-1250 part",
      raw: latin1("P\xF8\xEDli\x9A \x9Elu\x9Dou\xE8k\xFD"),
      encoding: undefined,
      charset: "windows-1250",
      text: "Příliš žluťoučký",
    },
    {
      name: "a part with an unknown charset",
      raw: latin1("plain"),
      encoding: "7bit",
      charset: "x-unknown",
      text: "plain",
    },
  ])("decodes $name", ({ raw, encoding, charset, text }) => {
    expect(decodeBodyPartPrefix(raw, encoding, charset)).toBe(text);
  });
});

describe("bodyPartPrefixInText", () => {
  // multipart/mixed (outer) of multipart/alternative (1: text 1.1, html 1.2) and a PDF (2), as imapflow numbers them.
  const structure: MessageStructureObject = {
    type: "multipart/mixed",
    parameters: { boundary: "outer" },
    childNodes: [
      {
        part: "1",
        type: "multipart/alternative",
        parameters: { boundary: "inner" },
        childNodes: [
          { part: "1.1", type: "text/plain" },
          { part: "1.2", type: "text/html" },
        ],
      },
      { part: "2", type: "application/pdf" },
    ],
  };
  const text = [
    "This is a preamble.",
    "--outer",
    'Content-Type: multipart/alternative; boundary="inner"',
    "",
    "--inner",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Plain line one",
    "Plain line two",
    "--inner",
    "",
    "<p>Html</p>",
    "--inner--",
    "--outer",
    "Content-Type: application/pdf",
    "",
    "JVBERi0=",
    "--outer--",
    "",
  ].join("\r\n");

  it.each([
    { section: "1.1", cut: text.length, part: "Plain line one\r\nPlain line two" },
    // A part without header fields starts right after the blank line.
    { section: "1.2", cut: text.length, part: "<p>Html</p>" },
    { section: "2", cut: text.length, part: "JVBERi0=" },
    // Cut inside the part's content: what came before the cut.
    { section: "1.1", cut: text.indexOf("line two"), part: "Plain line one\r\nPlain " },
    // Cut inside the part's header block, and before the part's delimiter: nothing to read.
    { section: "1.1", cut: text.indexOf("charset"), part: undefined },
    { section: "2", cut: text.indexOf("<p>"), part: undefined },
    // No such part, and a way through a node that is not a multipart.
    { section: "3", cut: text.length, part: undefined },
    { section: "1.1.1", cut: text.length, part: undefined },
  ])("reads part $section of a TEXT section cut at $cut octets", ({ section, cut, part }) => {
    const found = bodyPartPrefixInText(Buffer.from(text.slice(0, cut), "latin1"), structure, section);
    expect(found?.toString("latin1")).toBe(part);
  });

  it("finds the first part of a body without a preamble", () => {
    const found = bodyPartPrefixInText(
      Buffer.from("--b\r\nContent-Type: text/plain\r\n\r\nHello\r\n--b--\r\n", "latin1"),
      { type: "multipart/mixed", parameters: { boundary: "b" }, childNodes: [{ part: "1", type: "text/plain" }] },
      "1",
    );
    expect(found?.toString("latin1")).toBe("Hello");
  });
});
