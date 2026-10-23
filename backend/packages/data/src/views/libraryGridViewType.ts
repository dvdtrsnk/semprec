import { registerViewType, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { libraryModuleContractSchema } from "../library/libraryModuleContract.js";

/**
 * The card-grid view type issue #22 named but deferred to this issue: one generic view
 * type shared by both library-module instantiations (Books, Movies/TV), not a per-domain
 * view type — its config is exactly the generic "library module" contract
 * (coverKey/subtitleKey/...), so a future client can render any library-grid view the
 * same way regardless of which concrete domain it's showing.
 */
export const LIBRARY_GRID_VIEW_TYPE = "library-grid";

export function registerLibraryGridViewType(registry: ViewTypeRegistry): void {
  registerViewType(registry, LIBRARY_GRID_VIEW_TYPE, {
    configSchema: libraryModuleContractSchema,
    // Opaque to the backend; the client resolves this to its renderer component.
    clientComponent: "libraryCardGrid",
  });
}
