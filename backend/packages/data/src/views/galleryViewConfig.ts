import { z } from "zod";

/**
 * Config of the built-in `gallery` view type. `columns` and `aspect` are required; `coverKey`
 * (the property key whose image is the tile photo) is optional and, like `library-grid`'s keys,
 * is not checked against the database's properties. Not strict: the common view-config fields
 * (filter, sort, groupBy, visibility, ...) stay allowed.
 */
export const galleryViewConfigSchema = z.object({
  columns: z.union([z.literal(2), z.literal(3)]),
  aspect: z.enum(["3:4", "4:3"]),
  coverKey: z.string().min(1).optional(),
});
