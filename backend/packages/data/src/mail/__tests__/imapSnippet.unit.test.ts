import { describe, expect, it } from "vitest";
import { decodeBodyPartPrefix } from "../imapSnippet.js";

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
