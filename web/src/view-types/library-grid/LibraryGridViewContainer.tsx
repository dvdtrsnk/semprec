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

type Phase =
  | { status: "loading" }
  | { status: "error"; error: { code: string }; source: "initial" | "locale" }
  | { status: "ready" };

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
 * never overwrite a later one, and it also aborts that stale request via `AbortController` rather
 * than just ignoring its eventual result. "Load more" follows `nextCursor` only when the user
 * asks for it. Retry repeats whichever request last failed: the initial load, or the current
 * locale's property fetch.
 */
export function LibraryGridViewContainer({ viewId, databaseId }: ViewRendererProps) {
  const { user, api } = useAuthenticatedWebContext();
  const [contract, setContract] = useState<LibraryModuleContract>(EMPTY_CONTRACT);
  const [properties, setProperties] = useState<LibraryPropertyDisplay[]>([]);
  const [items, setItems] = useState<LibraryGridItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [retryTick, setRetryTick] = useState(0);
  const generationRef = useRef(0);
  const localeRef = useRef<string | null>(null);
  const phaseRef = useRef<Phase>(phase);
  const initialLoadCompleteRef = useRef(false);
  const propertyAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Initial load / view or database change / explicit retry of the initial load: view, properties,
  // and the first item page concurrently.
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    localeRef.current = user.locale;
    initialLoadCompleteRef.current = false;
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
          initialLoadCompleteRef.current = true;
          setPhase({ status: "error", error: { code: "invalid_contract" }, source: "initial" });
          return;
        }
        if ("code" in query) {
          initialLoadCompleteRef.current = true;
          setPhase({ status: "error", error: { code: query.code }, source: "initial" });
          return;
        }

        setContract(parsedContract.data);
        setProperties(catalog.properties.map(toPropertyDisplay));
        setItems(query.items);
        setNextCursor(query.nextCursor);
        initialLoadCompleteRef.current = true;
        setPhase({ status: "ready" });
      } catch {
        if (generationRef.current !== generation) return;
        initialLoadCompleteRef.current = true;
        setPhase({ status: "error", error: { code: "unavailable" }, source: "initial" });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale is handled by the effect below, deliberately not here.
  }, [viewId, databaseId, api, retryTick]);

  // Locale change only: re-resolve the property catalog, never re-fetching the view or items. Also
  // re-runs whenever `phase.status` settles, so a locale change that arrived mid-initial-load is
  // picked up once that load finishes instead of being silently dropped.
  useEffect(() => {
    if (localeRef.current === null || localeRef.current === user.locale) return;
    // The initial load owns the current generation until it settles; deferring avoids racing it,
    // and this effect re-runs once `phase.status` changes to pick the locale change back up.
    if (!initialLoadCompleteRef.current) return;
    // A failed initial load leaves nothing to re-project; retrying it is the initial effect's job.
    if (phaseRef.current.status === "error" && phaseRef.current.source === "initial") return;
    localeRef.current = user.locale;
    fetchPropertiesForCurrentLocale();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchPropertiesForCurrentLocale closes over state set below it; re-declaring it as a dep would re-run this effect on every render.
  }, [user.locale, databaseId, api, phase.status]);

  // Re-resolves the property catalog for the locale currently in `localeRef`, aborting any
  // still-in-flight property request from a previous call (issue #88: a locale change aborts
  // any older in-flight property request). Used by the locale-change effect above and by retry.
  function fetchPropertiesForCurrentLocale(): void {
    propertyAbortControllerRef.current?.abort();
    const controller = new AbortController();
    propertyAbortControllerRef.current = controller;

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setPhase({ status: "loading" });

    void (async () => {
      try {
        const catalog = await api.listProperties(databaseId, { signal: controller.signal });
        if (generationRef.current !== generation) return;
        setProperties(catalog.properties.map(toPropertyDisplay));
        setPhase({ status: "ready" });
      } catch {
        if (generationRef.current !== generation) return;
        setPhase({ status: "error", error: { code: "unavailable" }, source: "locale" });
      }
    })();
  }

  function handleCreated(item: LibraryGridItem): void {
    setItems((current) => {
      const index = current.findIndex((existing) => existing.id === item.id);
      if (index === -1) return [...current, item];
      const next = current.slice();
      next[index] = item;
      return next;
    });
  }

  function handleLoadMore(): void {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    const generation = generationRef.current;

    void (async () => {
      try {
        const query = await api.queryView(viewId, { cursor: nextCursor, limit: QUERY_LIMIT });
        if (generationRef.current !== generation) return;
        if ("code" in query) {
          setLoadingMore(false);
          setLoadMoreError(true);
          return;
        }
        setItems((current) => [...current, ...query.items]);
        setNextCursor(query.nextCursor);
        setLoadingMore(false);
      } catch {
        if (generationRef.current !== generation) return;
        setLoadingMore(false);
        setLoadMoreError(true);
      }
    })();
  }

  function handleRetry(): void {
    if (phase.status !== "error") return;
    if (phase.source === "initial") {
      setRetryTick((tick) => tick + 1);
    } else {
      fetchPropertiesForCurrentLocale();
    }
  }

  const state: LibraryGridState =
    phase.status === "ready"
      ? { status: "ready", items, nextCursor, loadingMore, loadMoreError }
      : phase.status === "error"
        ? { status: "error", error: phase.error }
        : { status: "loading" };

  return (
    <LibraryGridView
      viewId={viewId}
      databaseId={databaseId}
      contract={contract}
      properties={properties}
      state={state}
      onCreated={handleCreated}
      onLoadMore={handleLoadMore}
      onRetry={handleRetry}
    />
  );
}
