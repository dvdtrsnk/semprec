import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { identifier, parseRecord, readBounded, serializeRecord, specDigest, touchesProtectedPaths, validateSpecification } from "./records.mjs";

export async function handoverIds(root) {
  const result = new Set();
  const directory = resolve(root, "issues/handovers");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".gitkeep") continue;
    if (!entry.isFile() || !entry.name.endsWith(".md")) throw new Error(`Unexpected handover entry: ${entry.name}`);
    const id = identifier(entry.name.slice(0, -3));
    if (!(await readBounded(resolve(directory, entry.name))).trim()) throw new Error(`Empty handover ${id}`);
    result.add(id);
  }
  return result;
}

/** A directory reservation serializes cooperating CLI writers. Crashed locks require explicit inspection. */
export async function mutateIssue(root, id, expectedSha256, change) {
  identifier(id);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Expected file SHA-256 is required");
  const path = resolve(root, `issues/items/${id}.md`);
  const lock = resolve(root, `issues/items/.${id}.lock`);
  await mkdir(lock);
  let temporary;
  let primaryError;
  try {
    const before = await readBounded(path);
    const currentHash = createHash("sha256").update(before).digest("hex");
    if (currentHash !== expectedSha256) throw new Error("Issue changed; reread before writing");
    const issue = parseRecord(before);
    const changed = await change(issue);
    const content = serializeRecord(changed);
    temporary = resolve(root, `issues/items/.${id}.${randomUUID()}.tmp`);
    await writeExclusive(temporary, content);
    // Detect editor changes made while the CLI mutation was being prepared.
    if (await readBounded(path) !== before) throw new Error("Issue changed during update");
    await rename(temporary, path);
    temporary = undefined;
    return changed;
  } catch (error) { primaryError = error; throw error; }
  finally {
    const failures = [];
    if (temporary) try { await rm(temporary); } catch (error) { failures.push(error); }
    try { await rm(lock, { recursive: true }); } catch (error) { failures.push(error); }
    if (failures.length) {
      if (primaryError) console.error(`Issue cleanup failed (${failures.length} operation(s)); preserving original error`);
      else throw new AggregateError(failures, "Issue cleanup failed");
    }
  }
}

export async function writeExclusive(path, content) {
  const handle = await open(path, "wx");
  let primaryError;
  try { await handle.writeFile(content); await handle.sync(); }
  catch (error) { primaryError = error; throw error; }
  finally {
    try { await handle.close(); }
    catch (error) {
      if (primaryError) console.error("Issue file close failed; preserving original error");
      else throw error;
    }
  }
}

/** Re-import is safe only for identical generated files; local edits are never overwritten. */
export async function writeImportedFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let primaryError;
  try {
    await writeExclusive(temporary, content);
    try { await link(temporary, path); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const info = await lstat(path);
      if (!info.isFile() || !Buffer.from(await readFile(path)).equals(Buffer.from(content)))
        throw new Error(`Import conflicts with existing file: ${path}`);
    }
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { await rm(temporary, { force: true }); }
    catch (error) {
      if (primaryError) console.error("Import temporary-file cleanup failed; preserving original error");
      else throw error;
    }
  }
}

export function approveIssue(issue, actor, now = new Date().toISOString()) {
  if (typeof actor !== "string" || !actor.trim() || actor.length > 200) throw new Error("Approval actor is required");
  if (issue.metadata.kind !== "implementation" || issue.metadata.state !== "open") throw new Error("Only open implementation issues can be approved");
  validateSpecification(issue);
  issue.metadata.labels = [...new Set([...issue.metadata.labels.filter(label => label !== "spec:proposed"), "spec:approved"])];
  issue.metadata.approval = { specSha256: specDigest(issue), source: "repository", actor, at: now };
  issue.metadata.updatedAt = now;
  return issue;
}

export function queueIssue(issue, now = new Date().toISOString()) {
  if (issue.metadata.state !== "open" || issue.metadata.kind !== "implementation"
    || !issue.metadata.labels.includes("spec:approved") || issue.metadata.approval?.specSha256 !== specDigest(issue))
    throw new Error("Queue requires current approved implementation specification");
  if (touchesProtectedPaths(issue))
    throw new Error("Protected-path work is maintainer-implemented and cannot be queued");
  issue.metadata.labels = [...new Set([...issue.metadata.labels, "agent:ready"])];
  issue.metadata.updatedAt = now;
  return issue;
}

export function blockIssue(issue, now = new Date().toISOString()) {
  if (issue.metadata.state !== "open") throw new Error("Cannot block a closed issue");
  issue.metadata.labels = [...new Set([...issue.metadata.labels, "agent:blocked"])];
  issue.metadata.updatedAt = now;
  return issue;
}

export function reopenIssue(issue, now = new Date().toISOString()) {
  if (issue.metadata.state !== "closed") throw new Error("Issue is already open");
  issue.metadata.state = "open";
  issue.metadata.stateReason = null;
  issue.metadata.closedAt = null;
  issue.metadata.resolution = null;
  issue.metadata.labels = issue.metadata.labels.filter(label => label !== "agent:ready");
  issue.metadata.updatedAt = now;
  return issue;
}
