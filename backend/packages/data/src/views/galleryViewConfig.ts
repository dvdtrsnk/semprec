import { z } from "zod";

/**
 * `coverKey` is not checked against the database's properties (like `library-grid`'s keys). Not strict, so the
 * common view-config fields stay allowed.
 */
export const galleryViewConfigSchema = z.object({
  columns: z.union([z.literal(2), z.literal(3)]),
  aspect: z.enum(["3:4", "4:3"]),
  coverKey: z.string().min(1).optional(),
});
