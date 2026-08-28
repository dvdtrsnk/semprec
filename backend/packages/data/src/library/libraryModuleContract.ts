import { z } from "zod";

/**
 * The generic "library module" contract (issue #25): a named set of property-key slots
 * that Books and Movies/TV each fill in with their own keys and ownership — two instances
 * of one contract, not two separate implementations. `coverGlyph`/`secondaryRatingLabel`
 * are literal display values (an emoji, a label string), not property keys.
 */
export interface LibraryModuleContract {
  /** `type: 'image'`, `owner: 'system'` — `{ blobId }` over the shared `blobs` table. */
  coverKey: string;
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
  subtitleKey: z.string(),
  ratingKey: z.string(),
  secondaryRatingKey: z.string().optional(),
  secondaryRatingLabel: z.string().optional(),
  sourceUrlKey: z.string().optional(),
  statusKey: z.string(),
  coverGlyph: z.string().optional(),
});

export const BOOKS_LIBRARY_CONTRACT: LibraryModuleContract = {
  coverKey: "cover",
  subtitleKey: "author",
  ratingKey: "rating",
  statusKey: "status",
  coverGlyph: "\u{1F4DA}", // 📚
};

export const MOVIES_LIBRARY_CONTRACT: LibraryModuleContract = {
  coverKey: "cover",
  subtitleKey: "year",
  ratingKey: "rating",
  secondaryRatingKey: "secondaryRating",
  secondaryRatingLabel: "Critics' rating",
  sourceUrlKey: "sourceUrl",
  statusKey: "status",
  coverGlyph: "\u{1F3AC}", // 🎬
};
