import { z } from "zod";

/** The item system timestamps a sort can name instead of a property (issue #1594). */
const SYSTEM_SORT_FIELDS = ["createdAt", "updatedAt"] as const;
export type SystemSortField = (typeof SYSTEM_SORT_FIELDS)[number];

const direction = z.enum(["asc", "desc"]);

/**
 * One sort key: a property of the database (`{ property, direction }`) or an item system timestamp
 * (`{ system, direction }`). The two namespaces are separate, so a database's own property called
 * `createdAt` never shadows the system field. A spec naming both is rejected: each variant requires the
 * other's key to be absent.
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
