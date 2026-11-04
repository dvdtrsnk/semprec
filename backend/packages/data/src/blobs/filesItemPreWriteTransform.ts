import type { ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { filesTypeForMimeType } from "./fileTypeDetection.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const filesItemPreWriteTransform: ItemPreWriteTransform = async ({ client, stored, patch }) => {
  if (stored !== null || Object.hasOwn(patch, "type")) return patch;
  const file = patch.file;
  if (typeof file !== "object" || file === null || !("blobId" in file)) return patch;
  const id = file.blobId;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return patch;
  const { rows } = await client.query<{ mime_type: string }>(
    "SELECT mime_type FROM blobs WHERE tenant_id = app_tenant_default() AND id = $1",
    [id],
  );
  const type = rows[0] ? filesTypeForMimeType(rows[0].mime_type) : null;
  return type === null ? patch : { ...patch, type };
};
