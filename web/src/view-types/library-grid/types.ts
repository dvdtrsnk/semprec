import { z } from "zod";

/**
 * The generic "library module" contract (issue #25's `libraryModuleContract.ts`, re-declared
 * here because `web/` has no dependency on backend packages): a named set of property-key
 * slots Books and Movies/TV each fill with their own keys. `secondaryRatingLabel` is an i18n
 * catalog key, never literal display text.
 */
export const libraryModuleContractSchema = z.object({
  coverKey: z.string(),
  subtitleKey: z.string(),
  ratingKey: z.string(),
  secondaryRatingKey: z.string().optional(),
  secondaryRatingLabel: z.string().optional(),
  sourceUrlKey: z.string().optional(),
  statusKey: z.string(),
  coverGlyph: z.string().optional(),
});

export type LibraryModuleContract = z.infer<typeof libraryModuleContractSchema>;

export const libraryGridCoverValueSchema = z.object({ blobId: z.string() });

export interface LibraryGridItem {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LibraryPropertyDisplay {
  key: string;
  type: string;
  label: string;
  options?: Array<{ key: string; label: string }>;
}

export type LibraryGridState =
  | { status: "loading" }
  | { status: "error"; error: { code: string } }
  | { status: "ready"; items: LibraryGridItem[]; nextCursor: string | null; loadingMore: boolean };

export interface LibraryGridViewProps {
  viewId: string;
  databaseId: string;
  contract: LibraryModuleContract;
  properties: LibraryPropertyDisplay[];
  state: LibraryGridState;
  onCreated(item: LibraryGridItem): void;
  onLoadMore(): void;
  onRetry(): void;
}

/** The sole property whose `type` is `'title'` — the card's title text. Not part of `LibraryModuleContract`. */
export function findTitleProperty(properties: LibraryPropertyDisplay[]): LibraryPropertyDisplay | null {
  const titleProperties = properties.filter((property) => property.type === "title");
  return titleProperties.length === 1 ? titleProperties[0]! : null;
}

export function findProperty(properties: LibraryPropertyDisplay[], key: string): LibraryPropertyDisplay | undefined {
  return properties.find((property) => property.key === key);
}

/**
 * A select-typed value renders by exact option-key lookup, falling back to the raw stored key
 * when metadata lacks that option; any other type renders its raw value as text.
 */
export function displayFieldValue(property: LibraryPropertyDisplay | undefined, rawValue: unknown): string {
  if (property?.type === "select") {
    const match = property.options?.find((option) => option.key === rawValue);
    if (match) return match.label;
  }
  return String(rawValue);
}
