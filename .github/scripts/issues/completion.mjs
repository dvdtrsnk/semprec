#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { isEntryScript } from "../is-entry-script.mjs";
import { digest, identifier, parseRecord, readBounded, specDigest } from "./records.mjs";
const git = promisify(execFile);

/** Verify completion against the approved base; rebases retain original proposal provenance. */
export async function verifyCompletion(root, id, revision, fileSha256) {
  identifier(id);
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{64}$/.test(fileSha256)) throw new Error("Frozen issue identity is required");
  const path = `issues/items/${id}.md`;
  const base = (await git("git", ["show", `${revision}:${path}`], { cwd: root, timeout: 30000, maxBuffer: 1_100_000, encoding: "utf8" })).stdout;
  if (digest(base) !== fileSha256) throw new Error("Frozen issue bytes do not match dispatch");
  const before = parseRecord(base); const after = parseRecord(await readBounded(resolve(root, path)));
  if (before.metadata.kind !== "implementation" || specDigest(before) !== specDigest(after) || before.metadata.approval?.specSha256 !== specDigest(before) || after.metadata.approval?.specSha256 !== specDigest(before)) throw new Error("Completion changed the approved specification");
  if (after.metadata.state !== "closed" || after.metadata.stateReason !== "completed" || !after.metadata.resolution) throw new Error("Issue completion metadata is missing");
  if (!(await readBounded(resolve(root, `issues/handovers/${id}.md`))).trim()) throw new Error("Completion handover is empty");
  return after.metadata.resolution;
}
if (isEntryScript(import.meta.url)) verifyCompletion(process.cwd(), ...process.argv.slice(2)).then(() => console.log("Repository issue completion verified")).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
