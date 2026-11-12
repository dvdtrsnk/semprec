import { z } from "zod";

/**
 * The generic "library module" contract (issue #25): a named set of property-key slots
 * that Books and Movies/TV each fill in with their own keys and ownership — two instances
 * of one contract, not two separate implementations. `coverGlyph` is a literal emoji fallback;
 * `secondaryRatingLabel` is an i18n catalog key, not display text or a property key.
 */
export interface LibraryModuleContract {
  /** `type: 'image'`, `owner: 'system'` — `{ blobId }` over the shared `blobs` table. */
  coverKey: string;
  /** `type: 'image'`, `owner: 'user'` — `{ blobId }` of the cover the user chose; shown instead of `coverKey` when set. */
  coverOverrideKey?: string;
  /** `type: 'checkbox'`, `owner: 'user'` — the user removed the cover; nothing is shown while it is true. */
  coverRemovedKey?: string;
  /** `type: 'select'`, `owner: 'user'`, one of `LIBRARY_COVER_SOURCES` — where the override came from. */
  coverSourceKey?: string;
  automationFillableKeys?: string[];
  /** Shown under the title on the card: author for Books, year for Movies. */
  subtitleKey: string;
  /** The primary, purely user-entered rating; the heartbeat never touches it. */
  ratingKey: string;
  /** Optional external rating (e.g. critics'), `owner: 'system'`. */
  secondaryRatingKey?: string;
  secondaryRatingLabel?: string;
  /** Optional link to the source page, `type: 'url'`, `owner: 'system'`. */
  sourceUrlKey?: string;
  /** User-facing status pill (reading/watching status). */
  statusKey: string;
  /** Emoji overlay fallback while `cover` is missing. */
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

/** The keys of the user-owned cover properties (issue #1793) that both library databases seed. */
export const COVER_OVERRIDE_KEY = "coverOverride";
export const COVER_REMOVED_KEY = "coverRemoved";
export const COVER_SOURCE_KEY = "coverSource";

/** The option values of the `coverSource` property: a suggested cover, a photo taken by the user, an image the user picked. */
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
