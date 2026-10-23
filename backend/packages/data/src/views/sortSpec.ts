import { z } from "zod";

export const sortSpecSchema = z.object({
  property: z.string().min(1),
  direction: z.enum(["asc", "desc"]),
});
export type SortSpec = z.infer<typeof sortSpecSchema>;

export const sortConfigSchema = z.array(sortSpecSchema);

export function parseSortConfig(raw: unknown): SortSpec[] {
  return sortConfigSchema.parse(raw);
}
