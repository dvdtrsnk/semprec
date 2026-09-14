import { useEffect, useRef, useState } from "react";
import { useAuthenticatedWebContext } from "../../authenticatedWebContext.js";
import type { Property } from "../../api/authenticatedApiClient.js";
import type { ViewRendererProps } from "../registry.js";
import { LibraryGridView } from "./LibraryGridView.js";
import "./libraryGrid.css";
import {
  libraryModuleContractSchema,
  type LibraryGridItem,
  type LibraryGridState,
  type LibraryModuleContract,
  type LibraryPropertyDisplay,
} from "./types.js";

const QUERY_LIMIT = 50;

const EMPTY_CONTRACT: LibraryModuleContract = { coverKey: "", subtitleKey: "", ratingKey: "", statusKey: "" };

type Phase = { status: "loading" } | { status: "error"; error: { code: string } } | { status: "ready" };

function toPropertyDisplay(property: Property): LibraryPropertyDisplay {
  return {
    key: property.key,
    type: property.type,
    label: property.label,
    ...(property.options ? { options: property.options } : {}),
  };
}

/**
 * Fetches a `library-grid` view's contract, resolved property catalog, and first page of items,
 * and drives `LibraryGridView`'s discriminated `state` prop from them (issue #88). A locale
 * change re-resolves only the property catalog — labels are server-resolved (#218), items/view
 * need not change — guarded by a request generation so a slow, now-stale locale request can
 * never overwrite a later one.
 */
export function LibraryGridViewContainer({ viewId, databaseId }: ViewRendererProps) {
  const { user, api } = useAuthenticatedWebContext();
  const [contract, setContract] = useState<LibraryModuleContract>(EMPTY_CONTRACT);
  const [properties, setProperties] = useState<LibraryPropertyDisplay[]>([]);
  const [items, setItems] = useState<LibraryGridItem[]>([]);
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const generationRef = useRef(0);
  const localeRef = useRef<string | null>(null);

  // Initial load / view or database change: view, properties, and the first item page concurrently.
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    localeRef.current = user.locale;
    setPhase({ status: "loading" });

    void (async () => {
      try {
        const [view, catalog, query] = await Promise.all([
          api.getView(viewId),
          api.listProperties(databaseId),
          api.queryView(viewId, { cursor: null, limit: QUERY_LIMIT }),
        ]);
        if (generationRef.current !== generation) return;

        const parsedContract = libraryModuleContractSchema.safeParse(view.config);
        if (!parsedContract.success) {
          setPhase({ status: "error", error: { code: "invalid_contract" } });
          return;
        }
        if ("code" in query) {
          setPhase({ status: "error", error: { code: query.code } });
          return;
        }

        setContract(parsedContract.data);
        setProperties(catalog.properties.map(toPropertyDisplay));
        setItems(query.items);
        setPhase({ status: "ready" });
      } catch {
        if (generationRef.current !== generation) return;
        setPhase({ status: "error", error: { code: "unavailable" } });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale is handled by the effect below, deliberately not here.
  }, [viewId, databaseId, api]);

  // Locale change only: re-resolve the property catalog, never re-fetching the view or items.
  useEffect(() => {
    if (localeRef.current === null || localeRef.current === user.locale) return;
    localeRef.current = user.locale;

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setPhase({ status: "loading" });

    void (async () => {
      try {
        const catalog = await api.listProperties(databaseId);
        if (generationRef.current !== generation) return;
        setProperties(catalog.properties.map(toPropertyDisplay));
        setPhase({ status: "ready" });
      } catch {
        if (generationRef.current !== generation) return;
        setPhase({ status: "error", error: { code: "unavailable" } });
      }
    })();
  }, [user.locale, databaseId, api]);

  function handleCreated(item: LibraryGridItem): void {
    setItems((current) => {
      const index = current.findIndex((existing) => existing.id === item.id);
      if (index === -1) return [...current, item];
      const next = current.slice();
      next[index] = item;
      return next;
    });
  }

  const state: LibraryGridState = phase.status === "ready" ? { status: "ready", items } : phase;

  return (
    <LibraryGridView
      viewId={viewId}
      databaseId={databaseId}
      contract={contract}
      properties={properties}
      state={state}
      onCreated={handleCreated}
    />
  );
}
