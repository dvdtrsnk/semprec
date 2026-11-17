import { z } from "zod";
import type { ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { getPropertyByKey, getPropertyForUpdate } from "../chokePoint/propertiesStore.js";
import { filesTypeForMimeType } from "./fileTypeDetection.js";
import { getDetectedBlobMimeType } from "./blobsStore.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const filesItemPreWriteTransform: ItemPreWriteTransform = async ({ client, database, stored, patch }) => {
  if (stored !== null || Object.hasOwn(patch, "type")) return patch;
  const file = patch.file;
  if (typeof file !== "object" || file === null || !("blobId" in file)) return patch;
  const id = file.blobId;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return patch;
  const detectedMime = await getDetectedBlobMimeType(client, id);
  const type = detectedMime === null ? null : filesTypeForMimeType(detectedMime);
  if (type === null) return patch;
  const visible = await getPropertyByKey(client, database.id, "type");
  const property = visible ? await getPropertyForUpdate(client, visible.id) : null;
  if (!property || property.databaseId !== database.id || property.key !== "type" || property.type !== "select")
    return patch;
  const config = z.object({ options: z.array(z.object({ key: z.string() })) }).safeParse(property.config);
  return config.success && config.data.options.some((option) => option.key === type) ? { ...patch, type } : patch;
};
