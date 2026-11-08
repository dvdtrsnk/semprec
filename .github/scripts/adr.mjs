#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isEntryScript } from "./is-entry-script.mjs";

const platformAreas = {
  backend: ["backend", "cross-cutting"],
  web: ["web", "cross-cutting"],
  mobile: ["mobile", "apple", "cross-cutting"],
  shared: ["mobile", "apple", "cross-cutting"],
  android: ["mobile", "apple", "cross-cutting"],
  apple: ["mobile", "apple", "cross-cutting"],
  ios: ["mobile", "apple", "cross-cutting"],
  macos: ["mobile", "apple", "cross-cutting"],
};
const areas = new Set(["backend", "web", "mobile", "apple", "cross-cutting"]);
const statuses = new Set(["proposed", "accepted", "superseded", "deprecated"]);

export function parseAdr(text, filename) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`${filename}: missing frontmatter`);
  const field = (name) => {
    const found = match[1].split(/\r?\n/).filter(line => line.startsWith(`${name}:`));
    if (found.length !== 1) throw new Error(`${filename}: expected one ${name}`);
    return found[0].slice(name.length + 1).trim();
  };
  const status = field("status");
  if (!statuses.has(status)) throw new Error(`${filename}: invalid status`);
  const list = /^\[([^\]]*)\]$/.exec(field("area"));
  if (!list) throw new Error(`${filename}: invalid area`);
  const tags = list[1].split(",").map(tag => tag.trim());
  if (tags.some(tag => !areas.has(tag)) || new Set(tags).size !== tags.length)
    throw new Error(`${filename}: unknown or duplicate area`);
  const date = field("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !filename.startsWith(`${date}-`))
    throw new Error(`${filename}: date must match permanent filename`);
  if (tags.includes("apple") && date >= "2026-10-24")
    throw new Error(`${filename}: use mobile for new Apple decisions`);
  field("supersedes");
  field("superseded-by");
  const title = /^# (.+)$/m.exec(text)?.[1];
  if (!title) throw new Error(`${filename}: missing title`);
  return { filename, status, area: tags, date, title };
}

export async function listAdrs(root, { platform, all = false } = {}) {
  if (platform !== undefined && !Object.hasOwn(platformAreas, platform))
    throw new Error(`Unknown platform: ${platform}`);
  const directory = resolve(root, "docs/adr");
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "README.md") continue;
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(entry.name))
      throw new Error(`Unexpected ADR entry: ${entry.name}`);
    const adr = parseAdr(await readFile(resolve(directory, entry.name), "utf8"), entry.name);
    if (!all && adr.status !== "accepted") continue;
    if (platform && !adr.area.some(area => platformAreas[platform].includes(area))) continue;
    result.push(adr);
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--platform" && argv[i + 1]) options.platform = argv[++i];
    else if (argv[i] === "--all") options.all = true;
    else if (argv[i] === "--json") json = true;
    else throw new Error("Usage: node .github/scripts/adr.mjs [--platform backend|web|mobile|shared|android|apple|ios|macos] [--all] [--json]");
  }
  const result = await listAdrs(process.cwd(), options);
  console.log(json ? JSON.stringify(result, null, 2) : result.map(adr => `docs/adr/${adr.filename} [${adr.status}; ${adr.area.join(", ")}]`).join("\n"));
}

if (isEntryScript(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
