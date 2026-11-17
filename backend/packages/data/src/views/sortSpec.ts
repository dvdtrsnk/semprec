import { z } from "zod";

const SYSTEM_SORT_FIELDS = ["createdAt", "updatedAt"] as const;
export type SystemSortField = (typeof SYSTEM_SORT_FIELDS)[number];

const direction = z.enum(["asc", "desc"]);

/**
 * A property (`{ property, direction }`) or a system timestamp (`{ system, direction }`). Separate namespaces, so a
 * property named `createdAt` never shadows the system field; a spec naming both is rejected.
 */
export const sortSpecSchema = z.union([
  z.object({ property: z.string().min(1), system: z.undefined().optional(), direction }),
  z.object({ system: z.enum(SYSTEM_SORT_FIELDS), property: z.undefined().optional(), direction }),
]);
export type SortSpec = z.infer<typeof sortSpecSchema>;

export const sortConfigSchema = z.array(sortSpecSchema);

export function parseSortConfig(raw: unknown): SortSpec[] {
  return sortConfigSchema.parse(raw);
}
