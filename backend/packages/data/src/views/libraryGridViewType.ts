import { registerViewType, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { libraryModuleContractSchema } from "../library/libraryModuleContract.js";

/** One card-grid view type shared by every library module (Books, Movies/TV); its config is the generic library contract. */
export const LIBRARY_GRID_VIEW_TYPE = "library-grid";

export function registerLibraryGridViewType(registry: ViewTypeRegistry): void {
  registerViewType(registry, LIBRARY_GRID_VIEW_TYPE, {
    configSchema: libraryModuleContractSchema,
    // Opaque to the backend; the client resolves this to its renderer component.
    clientComponent: "libraryCardGrid",
  });
}
