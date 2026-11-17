import { assertSupportedLibraryMetadataSource, LibraryMetadataConfigurationError } from "./libraryMetadataConfig.js";
import type { LibraryMetadataFetcher } from "./libraryMetadataJob.js";
import {
  downloadLibraryCover,
  fetchOpenLibrary,
  type LibraryCoverDownload,
  type LibraryHttpFetch,
} from "./openLibraryFetcher.js";
import { fetchGoogleBooks } from "./googleBooksFetcher.js";
import { fetchTmdb } from "./tmdbFetcher.js";

export interface LibraryMetadataFetcherOptions {
  fetch?: LibraryHttpFetch;
  downloadCover?: LibraryCoverDownload;
  tmdbToken?: string;
}

/** Composes the configured metadata sources without exposing provider errors. */
export function createLibraryMetadataFetcher(options: LibraryMetadataFetcherOptions = {}): LibraryMetadataFetcher {
  const fetcher = options.fetch ?? fetch;
  const cover = options.downloadCover ?? downloadLibraryCover;
  return async (item, config) => {
    assertSupportedLibraryMetadataSource(config.source);
    if (config.source === "none") return {};
    if (config.source === "tmdb") return fetchTmdb(item, fetcher, options.tmdbToken, cover);
    if (config.source === "openLibrary") {
      const first = await fetchOpenLibrary(item, fetcher, cover);
      if (first.status === "found") return first;
      const second = await fetchGoogleBooks(item, fetcher, cover);
      return second.status === "notFound" && first.status === "error" ? first : second;
    }
    throw new LibraryMetadataConfigurationError();
  };
}
