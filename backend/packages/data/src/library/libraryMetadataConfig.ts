export class LibraryMetadataConfigurationError extends Error {
  constructor() {
    super("Unsupported library metadata source configuration");
    this.name = "LibraryMetadataConfigurationError";
  }
}

export function assertSupportedLibraryMetadataSource(source: string): void {
  if (source !== "none" && source !== "openLibrary" && source !== "tmdb") {
    throw new LibraryMetadataConfigurationError();
  }
}
