#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { isEntryScript } from "../is-entry-script.mjs";
import { digest, identifier, object, readBounded, string } from "./records.mjs";
import { verifyCompletion } from "./completion.mjs";

/** Every PR revision must retain its local completion, including later fix/rebase rounds. */
export async function checkPullRequestCompletion(root, value) {
  const event = object(value, "event");
  if (event.pull_request === undefined) return { skipped: true };
  const pr = object(event.pull_request, "pull request"); const body = pr.body === null ? "" : string(pr.body, "PR body", 200000);
  const headers = [...body.matchAll(/^Repository-Issue: ([^\r\n]+)$/gm)];
  if (!headers.length && !/^Repository-Issue:/m.test(body)) return { skipped: true };
  if ([...body.matchAll(/^Repository-Issue:/gm)].length !== 1 || headers.length !== 1 || body.split(/\r?\n/)[0].trim() !== headers[0][0].trim()) throw new Error("PR requires one canonical first-line issue reference");
  const id = identifier(headers[0][1].trim()); const sha = object(pr.base, "PR base").sha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Verified PR base SHA is required");
  const content = (await promisify(execFile)("git", ["show", `${sha}:issues/items/${id}.md`], { cwd: root, timeout: 30000, maxBuffer: 1_100_000, encoding: "utf8" })).stdout;
  await verifyCompletion(root, id, sha, digest(content));
  return { id, completed: true };
}
if (isEntryScript(import.meta.url)) {
  const path = process.env.GITHUB_EVENT_PATH;
  const run = path ? readBounded(resolve(path), 20_000_000).then(text => checkPullRequestCompletion(process.cwd(), JSON.parse(text))) : Promise.reject(new Error("GITHUB_EVENT_PATH is required"));
  run.then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
