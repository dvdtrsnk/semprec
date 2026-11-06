import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { labeledSempMessageRefSchema, runInTenant } from "@semprec/shared";
import {
  createChokePoint,
  getDatabaseByModuleId,
  ingestUploadedBlob,
  LocalFsBlobStorageWriter,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { expandSempRefs } from "../refExpansion.js";

function pdfFixture(): Buffer {
  const stream = "BT /F1 24 Tf 20 100 Td (PDF reference sentinel) Tj ET";
  const objects = [
    "",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 300] /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = Buffer.byteLength(body);
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(`${body}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

describe("tenant-scoped reference blob expansion", () => {
  let admin: Pool;
  let runtime: Pool;
  let tenant: string;
  let foreign: string;
  let root: string;
  let files: LocalFsBlobStorageWriter;
  let mailAttachments: LocalFsBlobStorageWriter;

  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    root = await mkdtemp(join(tmpdir(), "semp-ref-expansion-"));
    files = new LocalFsBlobStorageWriter(join(root, "files"));
    mailAttachments = new LocalFsBlobStorageWriter(join(root, "mail"));
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      await runtime?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      if (root) await rm(root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Reference fixture cleanup failed", { cause: errors[0] });
  });

  async function createFile(owner: string, name: string, bytes: Buffer) {
    return runInTenant(owner, async () => {
      const upload = await ingestUploadedBlob(runtime, {
        mimeType: "application/octet-stream",
        source: Readable.from([bytes]),
        maxBytes: bytes.length + 1,
        storage: files,
      });
      const db = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files"));
      if (!db) throw new Error("Missing Files database");
      const item = await createChokePoint(runtime).createItem({
        databaseId: db.id,
        properties: { name, file: { blobId: upload.blob.id } },
      });
      return { kind: "item" as const, databaseId: db.id, itemId: item.id };
    });
  }

  it("extracts real PDF and DOCX bytes and turns a current image into an ephemeral JPEG", async () => {
    const docx = await readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures/reference-text.docx"));
    const image = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#abc123" } })
      .png()
      .toBuffer();
    const refs = [
      await createFile(tenant, "PDF", pdfFixture()),
      await createFile(tenant, "DOCX", docx),
      await createFile(tenant, "Image", image),
    ];
    const result = await runInTenant(tenant, () => expandSempRefs(runtime, refs, { files, mailAttachments }));
    expect(result.text).toContain("PDF reference sentinel");
    expect(result.text).toContain("DOCX reference sentinel");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mimeType).toBe("image/jpeg");
    expect(result.context).toHaveLength(3);
    expect(JSON.stringify(result.context)).not.toContain(result.images[0]?.data ?? "missing");
  });

  it("keeps metadata and finite notes for corrupt, oversized and unsupported inputs, and refuses foreign and random refs", async () => {
    const corrupt = await createFile(tenant, "Corrupt", Buffer.from("%PDF-corrupt"));
    const large = await createFile(
      tenant,
      "Large",
      Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(10 * 1024 * 1024)]),
    );
    const unknown = await createFile(tenant, "Unknown", Buffer.from("unknown payload"));
    const other = await createFile(foreign, "Private", pdfFixture());
    const before = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs"),
    );
    const result = await runInTenant(tenant, () =>
      expandSempRefs(runtime, [corrupt, large, unknown, other, { ...corrupt, itemId: randomUUID() }], {
        files,
        mailAttachments,
      }),
    );
    expect(result.text).toContain("Attachment text unavailable.");
    expect(result.text).toContain("Attachment exceeds the size limit.");
    expect(result.text).toContain("Attachment type cannot be extracted.");
    expect(result.text).not.toContain("Private");
    expect(result.images).toEqual([]);
    expect(result.context.map((ref) => ref.label)).toEqual(["Corrupt", "Large", "Unknown", "", ""]);
    const after = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs"),
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("preserves historical labels while fresh unavailable references carry empty labels", async () => {
    const own = await createFile(tenant, "Current label", Buffer.from("unsupported"));
    const other = await createFile(foreign, "Foreign label", Buffer.from("unsupported"));
    const missing = { ...own, itemId: randomUUID() };
    const refs = [own, other, missing, { ...own, label: "Historical label" }, { ...missing, label: "Old missing" }];
    const result = await runInTenant(tenant, () => expandSempRefs(runtime, refs, { files, mailAttachments }));
    expect(result.context).toEqual([
      { ...own, label: "Current label" },
      { ...other, label: "" },
      { ...missing, label: "" },
      { ...own, label: "Historical label" },
      { ...missing, label: "Old missing" },
    ]);
    for (const ref of result.context) expect(labeledSempMessageRefSchema.safeParse(ref).success).toBe(true);
    const sections = result.text.split("\n\n");
    expect(sections).toHaveLength(refs.length);
    expect(sections[0]).toContain("item: Current label");
    expect(sections[1]).toContain("item: no longer exists or is unavailable.");
    expect(sections[2]).toContain("item: no longer exists or is unavailable.");
    expect(sections[3]).toContain("item: Current label");
    expect(sections[4]).toContain("item: no longer exists or is unavailable.");
    expect(result.text).toContain("no longer exists or is unavailable");
    expect(result.text).not.toContain("Foreign label");
  });
});
