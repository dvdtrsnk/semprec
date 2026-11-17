import * as Y from "yjs";
import type { PoolClient } from "pg";
import { readPageBlocks, serializeInline } from "@semprec/block-model";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { getDocByItemId, readPageStatesForItems } from "./docsStore.js";
import { ConflictError } from "../errors.js";

export async function readPageSummary(client: PoolClient, itemId: string, locale: string, limit?: number) {
  const row = await getDocByItemId(client, itemId);
  if (row && row.kind !== "page")
    throw new ConflictError(`Item ${itemId} already has a '${row.kind}' doc; cannot read it as a page`, { itemId });
  const doc = new Y.Doc();
  try {
    if (row?.kind === "page") {
      const state = (await readPageStatesForItems(client, [itemId]))[0];
      if (state?.snapshot) Y.applyUpdate(doc, state.snapshot);
      for (const update of state?.updates ?? []) Y.applyUpdate(doc, update);
    }
    const titleValue: unknown = doc.getMap("meta").get("title");
    const catalogs = await loadModuleCatalogs(import.meta.url);
    const title =
      typeof titleValue === "string"
        ? titleValue
        : resolveCatalogLabel(null, locale === "cs" ? catalogs.cs : catalogs.en, catalogs.en, "page.notes.title");
    const all =
      row?.kind === "page" ? readPageBlocks(doc).filter((block) => !block.synthetic && block.id !== null) : [];
    const blocks = all.flatMap((block) =>
      block.id === null
        ? []
        : [
            {
              id: block.id,
              type: block.type,
              indent: block.indent,
              done: block.done,
              text: serializeInline(block.text),
              ...(block.pageId === null ? {} : { pageId: block.pageId }),
            },
          ],
    );
    return {
      docId: row?.id ?? null,
      kind: "page" as const,
      title,
      blocks: limit === undefined ? blocks : blocks.slice(0, limit),
      blockCount: blocks.length,
      subpageCount: blocks.filter((block) => block.type === "page").length,
      headings: blocks
        .filter((block) => block.type === "h1" || block.type === "h2" || block.type === "h3")
        .map(({ id, type, text }) => ({ id, type, text })),
      lastEditedAt: row?.lastEditedAt ?? null,
      lastEditedBy: row?.lastEditedBy ?? null,
    };
  } finally {
    doc.destroy();
  }
}
