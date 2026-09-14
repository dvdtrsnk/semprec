import { useState, type FormEvent, type ReactNode } from "react";
import { useAuthenticatedWebContext } from "../../authenticatedWebContext.js";
import { useLocalizedString } from "../../i18n/useLocalizedString.js";
import { libraryFallbackColorVar } from "./fallbackColor.js";
import {
  displayFieldValue,
  findProperty,
  findTitleProperty,
  libraryGridCoverValueSchema,
  type LibraryGridItem,
  type LibraryGridViewProps,
  type LibraryModuleContract,
  type LibraryPropertyDisplay,
} from "./types.js";

interface CardFieldSpec {
  key: string | undefined;
  labelOverrideKey?: string;
}

function readValue(item: LibraryGridItem, key: string | undefined): unknown {
  if (!key) return undefined;
  const value = item.properties[key];
  return value === null || value === undefined ? undefined : value;
}

/** `http(s)` only — a stored `sourceUrl` is user data and must not reach `href` unvalidated. */
function isSafeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Label fallback chain: locale translation → English translation → property metadata → raw key. */
function resolveFieldLabel(
  labelOverrideKey: string | undefined,
  property: LibraryPropertyDisplay | undefined,
  key: string | undefined,
  t: (key: string) => string,
): string {
  if (labelOverrideKey) {
    const translated = t(labelOverrideKey);
    return translated !== labelOverrideKey ? translated : (property?.label ?? translated);
  }
  return property?.label ?? key ?? "";
}

function CardCover({
  item,
  contract,
  title,
  blobUrl,
}: {
  item: LibraryGridItem;
  contract: LibraryModuleContract;
  title: string;
  blobUrl: (blobId: string) => string;
}) {
  const [broken, setBroken] = useState(false);
  const parsedCover = libraryGridCoverValueSchema.safeParse(item.properties[contract.coverKey]);
  const showFallback = broken || !parsedCover.success;

  if (showFallback) {
    return (
      <div
        className="library-card__cover library-card__cover--fallback"
        style={{ backgroundColor: libraryFallbackColorVar(item.id) }}
        role="img"
        aria-label={title}
      >
        {contract.coverGlyph ? (
          <span className="library-card__cover-glyph" aria-hidden="true">
            {contract.coverGlyph}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <img
      className="library-card__cover"
      src={blobUrl(parsedCover.data.blobId)}
      alt={title}
      onError={() => setBroken(true)}
    />
  );
}

function CardField({
  properties,
  field,
  t,
  item,
}: {
  properties: LibraryPropertyDisplay[];
  field: CardFieldSpec;
  t: (key: string) => string;
  item: LibraryGridItem;
}) {
  const rawValue = readValue(item, field.key);
  if (rawValue === undefined) return null;

  const property = field.key ? findProperty(properties, field.key) : undefined;
  const label = resolveFieldLabel(field.labelOverrideKey, property, field.key, t);

  return (
    <p className="library-card__field">
      <span className="library-card__field-label">{label}</span>
      <span className="library-card__field-value">{displayFieldValue(property, rawValue)}</span>
    </p>
  );
}

function LibraryCard({
  item,
  contract,
  properties,
  titleProperty,
  blobUrl,
  t,
}: {
  item: LibraryGridItem;
  contract: LibraryModuleContract;
  properties: LibraryPropertyDisplay[];
  titleProperty: LibraryPropertyDisplay;
  blobUrl: (blobId: string) => string;
  t: (key: string) => string;
}) {
  const title = String(readValue(item, titleProperty.key) ?? "");
  const sourceUrl = readValue(item, contract.sourceUrlKey);

  return (
    <li className="library-card">
      <CardCover item={item} contract={contract} title={title} blobUrl={blobUrl} />
      <h3 className="library-card__title">{title}</h3>
      <CardField properties={properties} field={{ key: contract.subtitleKey }} t={t} item={item} />
      <CardField properties={properties} field={{ key: contract.ratingKey }} t={t} item={item} />
      <CardField
        properties={properties}
        field={{ key: contract.secondaryRatingKey, labelOverrideKey: contract.secondaryRatingLabel }}
        t={t}
        item={item}
      />
      <CardField properties={properties} field={{ key: contract.statusKey }} t={t} item={item} />
      {typeof sourceUrl === "string" && isSafeUrl(sourceUrl) ? (
        <p className="library-card__field">
          <a className="library-card__source-link" href={sourceUrl} target="_blank" rel="noreferrer">
            {sourceUrl}
          </a>
        </p>
      ) : null}
    </li>
  );
}

function AddForm({
  databaseId,
  titleKey,
  onCreated,
  t,
}: {
  databaseId: string;
  titleKey: string;
  onCreated(item: LibraryGridItem): void;
  t: (key: string) => string;
}) {
  const { api } = useAuthenticatedWebContext();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setFailed(false);
    try {
      const item = await api.createItem(databaseId, { [titleKey]: trimmed });
      setSubmitting(false);
      setName("");
      setOpen(false);
      onCreated(item);
    } catch {
      setSubmitting(false);
      setFailed(true);
    }
  }

  if (!open) {
    return (
      <button type="button" className="library-grid__add-trigger" onClick={() => setOpen(true)}>
        {t("library.add")}
      </button>
    );
  }

  return (
    <form
      className="library-grid__add-form"
      aria-label={t("library.add")}
      onSubmit={(event) => void handleSubmit(event)}
      aria-busy={submitting}
    >
      <label className="library-grid__add-label">
        {t("library.add")}
        <input
          type="text"
          value={name}
          disabled={submitting}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </label>
      <button type="submit" disabled={submitting || name.trim().length === 0}>
        {t("library.add")}
      </button>
      {failed ? (
        <p className="library-grid__add-error" role="alert" aria-live="polite">
          {t("library.createError")}
        </p>
      ) : null}
    </form>
  );
}

/** The shared card-grid renderer for `library-grid` views (Books, Movies/TV — issue #25). */
export function LibraryGridView({
  viewId,
  databaseId,
  contract,
  properties,
  state,
  onCreated,
  onLoadMore,
  onRetry,
}: LibraryGridViewProps) {
  const t = useLocalizedString();
  const { api } = useAuthenticatedWebContext();
  const titleProperty = state.status === "ready" ? findTitleProperty(properties) : null;

  let body: ReactNode;
  if (state.status === "loading") {
    body = (
      <p className="library-grid__state" role="status" aria-live="polite">
        {t("common.loading")}
      </p>
    );
  } else if (state.status === "error") {
    body = (
      <div className="library-grid__state" role="alert">
        <p>{t("library.createError")}</p>
        <button type="button" className="library-grid__retry" onClick={onRetry}>
          {t("library.retry")}
        </button>
      </div>
    );
  } else if (!titleProperty) {
    body = (
      <p className="library-grid__state" role="alert">
        {t("library.createError")}
      </p>
    );
  } else if (state.items.length === 0) {
    body = (
      <p className="library-grid__state" role="status">
        {t("library.empty")}
      </p>
    );
  } else {
    body = (
      <>
        <ul className="library-grid__list">
          {state.items.map((item) => (
            <LibraryCard
              key={item.id}
              item={item}
              contract={contract}
              properties={properties}
              titleProperty={titleProperty}
              blobUrl={api.blobUrl}
              t={t}
            />
          ))}
        </ul>
        {state.nextCursor !== null ? (
          <button type="button" className="library-grid__load-more" onClick={onLoadMore} disabled={state.loadingMore}>
            {t("library.loadMore")}
          </button>
        ) : null}
        {state.loadMoreError ? (
          <p className="library-grid__load-more-error" role="alert" aria-live="polite">
            {t("library.loadMoreError")}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <section className="library-grid" data-view-id={viewId}>
      {state.status === "ready" && titleProperty ? (
        <AddForm databaseId={databaseId} titleKey={titleProperty.key} onCreated={onCreated} t={t} />
      ) : null}
      {body}
    </section>
  );
}
