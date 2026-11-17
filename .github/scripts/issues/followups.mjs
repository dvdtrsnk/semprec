import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRecord, digest, loadCatalog, readBounded, relayIndex, relayNumber, serializeRecord } from "./records.mjs";
import { mutateIssue, writeExclusive } from "./store.mjs";

const cache = new WeakMap();
export async function localFollowups(client) {
  if (client.issueRoot === undefined) return null;
  if (!cache.has(client)) cache.set(client, backend(client.issueRoot, client.repository));
  return cache.get(client);
}
async function backend(root, repository) {
  let text;
  try { text = await readBounded(resolve(root, "issues/migration/state.json"), 100000); }
  catch (error) { throw new Error("Repository issue authority is unavailable", { cause: error }); }
  const state = JSON.parse(text);
  if (repository !== undefined && state.repository !== repository) throw new Error("Repository issue authority belongs to another repository");
  if (state.schemaVersion !== 1 || !["github", "repository"].includes(state.authority)) throw new Error("Invalid issue authority");
  if (state.authority !== "repository") return null;
  const catalog = () => loadCatalog(root);
  const item = async number => {
    const issue = relayIndex(await catalog()).get(number);
    if (!issue) throw new Error(`Local follow-up issue is missing: ${number}`);
    return issue;
  };
  const represent = issue => ({ number: relayNumber(issue.metadata.id), id: relayNumber(issue.metadata.id), canonicalId: issue.metadata.id,
    state: issue.metadata.state, title: issue.metadata.title, body: issue.body, labels: issue.metadata.labels });
  const update = async (number, change) => {
    const issue = await item(number); const id = issue.metadata.id;
    return mutateIssue(root, id, digest(await readBounded(resolve(root, `issues/items/${id}.md`))), value => { change(value); value.metadata.updatedAt = new Date().toISOString(); return value; });
  };
  return {
    async list(label, state) { return [...(await catalog()).values()].filter(issue => issue.metadata.labels.includes(label) && (state === "all" || issue.metadata.state === state)).map(represent); },
    async get(number) { return represent(await item(number)); },
    async comments(number) {
      const issue = await item(number); const directory = resolve(root, `issues/history/${issue.metadata.id}/comments`);
      let entries; try { entries = await readdir(directory); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
      const result = [];
      for (const name of entries) {
        if (!/^[a-zA-Z0-9-]+\.md$/.test(name)) throw new Error("Invalid local comment filename");
        const text = await readBounded(resolve(directory, name)); const end = text.indexOf("\n---\n", 4);
        if (!text.startsWith("---\n") || end < 0) throw new Error("Invalid local comment envelope");
        const metadata = Object.fromEntries(text.slice(4, end).split("\n").map(line => { const at = line.indexOf(": "); if (at < 0) throw new Error("Invalid comment metadata"); return [line.slice(0, at), JSON.parse(line.slice(at + 2))]; }));
        if (!Number.isSafeInteger(metadata.id) || typeof metadata.createdAt !== "string" || metadata.author !== null && typeof metadata.author !== "string") throw new Error("Invalid comment identity");
        result.push({ id: metadata.id, author: metadata.author ?? "ghost", createdAt: metadata.createdAt, body: text.slice(end + 5) });
      }
      return result;
    },
    async create({ title, body, labels }) {
      const index = relayIndex(await catalog());
      body = body.replace(/#(\d+)/g, (reference, number) => {
        const id = index.get(Number(number))?.metadata.id;
        return id?.startsWith("sp-") ? id : reference;
      });
      const line = body.split(/\r?\n/)[0];
      body = body.replace(line, line.replace(/#(\d+)/g, (reference, number) => index.get(Number(number))?.metadata.id ?? reference));
      const kind = labels.includes("followups:harvest") ? "harvest" : /^## Task\s*$/m.test(body) ? "implementation" : "epic";
      const issue = createRecord({ title, body, kind }); issue.metadata.labels = labels;
      const number = relayNumber(issue.metadata.id); if (index.has(number)) throw new Error("Local issue compatibility identity collision");
      await writeExclusive(resolve(root, `issues/items/${issue.metadata.id}.md`), serializeRecord(issue));
      return represent(issue);
    },
    async removeLabel(number, label) { await update(number, issue => { issue.metadata.labels = issue.metadata.labels.filter(value => value !== label); }); },
    async close(number) { await update(number, issue => { issue.metadata.state = "closed"; issue.metadata.stateReason = "completed"; issue.metadata.closedAt = new Date().toISOString(); }); },
    async comment(number, body) {
      const issue = await item(number); const uuid = randomUUID(); const id = Number.parseInt(uuid.replaceAll("-", "").slice(0, 12), 16);
      const metadata = { id, author: "relay", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), url: "" };
      const { mkdir } = await import("node:fs/promises"); const directory = resolve(root, `issues/history/${issue.metadata.id}/comments`); await mkdir(directory, { recursive: true });
      await writeExclusive(resolve(directory, `${uuid}.md`), `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${body}`);
      return { id };
    },
    async child(parentNumber, childNumber) {
      const parent = await item(parentNumber); if (parent.metadata.kind !== "epic") throw new Error("Local parent must be an epic");
      await update(childNumber, issue => { if (issue.metadata.parent && issue.metadata.parent !== parent.metadata.id) throw new Error("Child already has a parent"); issue.metadata.parent = parent.metadata.id; });
    },
  };
}
