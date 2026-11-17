import { z } from "zod";

/**
 * Property-key slots that Books and Movies/TV each fill in. `secondaryRatingLabel` is an i18n catalog key, not
 * display text or a property key.
 */
export interface LibraryModuleContract {
  /** System-owned `{ blobId }` image. */
  coverKey: string;
  /** User-chosen cover; shown instead of `coverKey` when set. */
  coverOverrideKey?: string;
  /** Nothing is shown while true. */
  coverRemovedKey?: string;
  coverSourceKey?: string;
  automationFillableKeys?: string[];
  subtitleKey: string;
  /** User-entered only; the heartbeat never touches it. */
  ratingKey: string;
  secondaryRatingKey?: string;
  secondaryRatingLabel?: string;
  sourceUrlKey?: string;
  statusKey: string;
  coverGlyph?: string;
}

export const libraryModuleContractSchema = z.object({
  coverKey: z.string(),
  coverOverrideKey: z.string().optional(),
  coverRemovedKey: z.string().optional(),
  coverSourceKey: z.string().optional(),
  automationFillableKeys: z.array(z.string()).optional(),
  subtitleKey: z.string(),
  ratingKey: z.string(),
  secondaryRatingKey: z.string().optional(),
  secondaryRatingLabel: z.string().optional(),
  sourceUrlKey: z.string().optional(),
  statusKey: z.string(),
  coverGlyph: z.string().optional(),
});

export const COVER_OVERRIDE_KEY = "coverOverride";
export const COVER_REMOVED_KEY = "coverRemoved";
export const COVER_SOURCE_KEY = "coverSource";

export const LIBRARY_COVER_SOURCES = ["candidate", "userPhoto", "userImage"] as const;
export type LibraryCoverSource = (typeof LIBRARY_COVER_SOURCES)[number];

export const BOOKS_LIBRARY_CONTRACT: LibraryModuleContract = {
  coverKey: "cover",
  coverOverrideKey: COVER_OVERRIDE_KEY,
  coverRemovedKey: COVER_REMOVED_KEY,
  coverSourceKey: COVER_SOURCE_KEY,
  automationFillableKeys: ["author", "year", "isbn"],
  subtitleKey: "author",
  ratingKey: "rating",
  statusKey: "status",
  coverGlyph: "\u{1F4DA}", // 📚
};

export const MOVIES_LIBRARY_CONTRACT: LibraryModuleContract = {
  coverKey: "cover",
  coverOverrideKey: COVER_OVERRIDE_KEY,
  coverRemovedKey: COVER_REMOVED_KEY,
  coverSourceKey: COVER_SOURCE_KEY,
  automationFillableKeys: ["year", "type"],
  subtitleKey: "year",
  ratingKey: "rating",
  secondaryRatingKey: "secondaryRating",
  secondaryRatingLabel: "property.movies.secondaryRating.name",
  sourceUrlKey: "sourceUrl",
  statusKey: "status",
  coverGlyph: "\u{1F3AC}", // 🎬
};
