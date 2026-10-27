import { resolve } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { digest, loadCatalog, readBounded, serializeRecord } from "./records.mjs";

/** A versioned observation survives scheduler restarts and resets when membership changes. */
export async function sweepLocalEpics(root, { dryRun = true, graceHours = 1, now = new Date().toISOString() } = {}) {
  if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > 168 || !Number.isFinite(Date.parse(now))) throw new Error("Invalid epic sweep clock");
  const catalog = await loadCatalog(root); const result = { announced: [], waiting: [], closed: [], withdrawn: [] };
  for (const issue of catalog.values()) {
    const meta = issue.metadata; if (meta.kind !== "epic" || meta.state !== "open") continue;
    const children = [...catalog.values()].filter(child => child.metadata.parent === meta.id);
    const membership = digest(JSON.stringify(children.map(child => [child.metadata.id, child.metadata.state]).sort()));
    const path = resolve(root, `issues/history/${meta.id}/epic-sweep.json`);
    let observation = null;
    try {
      observation = JSON.parse(await readBounded(path, 10000));
      if (observation.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(observation.membership) || !Number.isFinite(Date.parse(observation.observedAt))) throw new Error("Invalid epic observation");
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    const complete = !meta.labels.includes("epic:wip") && children.length > 0 && children.every(child => child.metadata.state === "closed");
    if (!complete) {
      if (observation) { result.withdrawn.push(meta.id); if (!dryRun) await rm(path); }
    } else if (!observation || observation.membership !== membership) {
      result.announced.push(meta.id);
      if (!dryRun) { await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify({ schemaVersion: 1, membership, observedAt: now }) + "\n"); }
    } else if (Date.parse(now) - Date.parse(observation.observedAt) < graceHours * 3600000) result.waiting.push(meta.id);
    else {
      result.closed.push(meta.id);
      if (!dryRun) {
        meta.state = "closed"; meta.stateReason = "completed"; meta.closedAt = now; meta.updatedAt = now;
        await writeFile(resolve(root, `issues/items/${meta.id}.md`), serializeRecord(issue));
      }
    }
  }
  return result;
}
