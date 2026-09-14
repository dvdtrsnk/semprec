import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedWebProvider } from "../../../authenticatedWebContext.js";
import type { AuthenticatedApiClient, Item } from "../../../api/authenticatedApiClient.js";
import { LibraryGridView } from "../LibraryGridView.js";
import type { LibraryGridItem, LibraryGridState, LibraryModuleContract, LibraryPropertyDisplay } from "../types.js";

const CONTRACT: LibraryModuleContract = {
  coverKey: "cover",
  subtitleKey: "year",
  ratingKey: "rating",
  secondaryRatingKey: "secondaryRating",
  secondaryRatingLabel: "property.movies.secondaryRating.name",
  sourceUrlKey: "sourceUrl",
  statusKey: "status",
  coverGlyph: "\u{1F3AC}",
};

const PROPERTIES: LibraryPropertyDisplay[] = [
  { key: "name", type: "title", label: "Name" },
  { key: "year", type: "number", label: "Year" },
  { key: "rating", type: "number", label: "Rating" },
  { key: "secondaryRating", type: "number", label: "Secondary rating" },
  {
    key: "status",
    type: "select",
    label: "Status",
    options: [
      { key: "watched", label: "Watched" },
      { key: "watching", label: "Watching" },
    ],
  },
  { key: "sourceUrl", type: "url", label: "Source" },
];

function item(overrides: Partial<LibraryGridItem> & { properties: Record<string, unknown> }): LibraryGridItem {
  return {
    id: "item-1",
    databaseId: "db-1",
    computed: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function fakeApi(overrides: Partial<AuthenticatedApiClient> = {}): AuthenticatedApiClient {
  return {
    getView: vi.fn(),
    listProperties: vi.fn(),
    queryView: vi.fn(),
    createItem: vi.fn(async () => ({
      id: "new-item",
      databaseId: "db-1",
      properties: {},
      computed: {},
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    })) as unknown as AuthenticatedApiClient["createItem"],
    blobUrl: vi.fn((blobId: string) => `/api/blobs/${blobId}?disposition=inline`),
    ...overrides,
  };
}

type TestState =
  | { status: "loading" }
  | { status: "error"; error: { code: string } }
  | {
      status: "ready";
      items: LibraryGridItem[];
      nextCursor?: string | null;
      loadingMore?: boolean;
      loadMoreError?: boolean;
    };

function renderView({
  state,
  locale = "en",
  contract = CONTRACT,
  properties = PROPERTIES,
  api = fakeApi(),
  onCreated = vi.fn(),
  onLoadMore = vi.fn(),
  onRetry = vi.fn(),
}: {
  state: TestState;
  locale?: string;
  contract?: LibraryModuleContract;
  properties?: LibraryPropertyDisplay[];
  api?: AuthenticatedApiClient;
  onCreated?: (item: LibraryGridItem) => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
}) {
  const resolvedState: LibraryGridState =
    state.status === "ready"
      ? {
          status: "ready",
          items: state.items,
          nextCursor: state.nextCursor ?? null,
          loadingMore: state.loadingMore ?? false,
          loadMoreError: state.loadMoreError ?? false,
        }
      : state;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthenticatedWebProvider value={{ user: { locale }, api }}>{children}</AuthenticatedWebProvider>
  );
  return {
    api,
    onCreated,
    onLoadMore,
    onRetry,
    ...render(
      <LibraryGridView
        viewId="view-1"
        databaseId="db-1"
        contract={contract}
        properties={properties}
        state={resolvedState}
        onCreated={onCreated}
        onLoadMore={onLoadMore}
        onRetry={onRetry}
      />,
      { wrapper },
    ),
  };
}

describe("LibraryGridView", () => {
  it("renders the loading state", () => {
    renderView({ state: { status: "loading" } });
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });

  it("renders the error state with library.createError", () => {
    renderView({ state: { status: "error", error: { code: "unavailable" } } });
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Try again.");
  });

  it("calls onRetry when the error state's retry button is clicked", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderView({ state: { status: "error", error: { code: "unavailable" } }, onRetry });

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows a load-more button only when nextCursor is not null, and calls onLoadMore", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    renderView({
      state: { status: "ready", items: [item({ properties: { name: "Dune" } })], nextCursor: "cursor-2" },
      onLoadMore,
    });

    const loadMore = screen.getByRole("button", { name: "Load more" });
    await user.click(loadMore);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("omits the load-more button when nextCursor is null", () => {
    renderView({
      state: { status: "ready", items: [item({ properties: { name: "Dune" } })], nextCursor: null },
    });

    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("disables the load-more button while loadingMore is true", () => {
    renderView({
      state: {
        status: "ready",
        items: [item({ properties: { name: "Dune" } })],
        nextCursor: "cursor-2",
        loadingMore: true,
      },
    });

    expect(screen.getByRole("button", { name: "Load more" })).toBeDisabled();
  });

  it("shows library.loadMoreError and keeps the load-more button enabled when a page fails to load", () => {
    renderView({
      state: {
        status: "ready",
        items: [item({ properties: { name: "Dune" } })],
        nextCursor: "cursor-2",
        loadingMore: false,
        loadMoreError: true,
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load more items. Try again.");
    expect(screen.getByRole("button", { name: "Load more" })).not.toBeDisabled();
  });

  it("renders the empty state only for ready with zero items", () => {
    renderView({ state: { status: "ready", items: [] } });
    expect(screen.getByText("No items yet.")).toBeInTheDocument();
  });

  it("renders a component-level createError when no property has type 'title'", () => {
    const noTitle = PROPERTIES.filter((property) => property.type !== "title");
    renderView({ state: { status: "ready", items: [item({ properties: {} })] }, properties: noTitle });
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Try again.");
  });

  it("renders a component-level createError when more than one property has type 'title'", () => {
    const twoTitles = [...PROPERTIES, { key: "alsoTitle", type: "title", label: "Also title" }];
    renderView({ state: { status: "ready", items: [item({ properties: {} })] }, properties: twoTitles });
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Try again.");
  });

  it("renders title, subtitle, rating, select status by option label, and secondary rating with its overriding i18n label", () => {
    renderView({
      state: {
        status: "ready",
        items: [
          item({
            properties: { name: "Dune", year: 2021, rating: 9, secondaryRating: 87, status: "watched" },
          }),
        ],
      },
    });

    expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument();
    expect(screen.getByText("2021")).toBeInTheDocument();
    expect(screen.getByText("Watched")).toBeInTheDocument();
    expect(screen.getByText("87")).toBeInTheDocument();
    expect(screen.getByText("Critics' rating")).toBeInTheDocument();
  });

  it("shows the Czech secondaryRatingLabel translation, never the raw key or the English literal", () => {
    renderView({
      locale: "cs",
      state: {
        status: "ready",
        items: [item({ properties: { name: "Dune", year: 2021, rating: 9, secondaryRating: 87, status: "watched" } })],
      },
    });

    expect(screen.getByText("Hodnocení kritiků")).toBeInTheDocument();
    expect(screen.queryByText("Critics' rating")).not.toBeInTheDocument();
    expect(screen.queryByText("property.movies.secondaryRating.name")).not.toBeInTheDocument();
  });

  it("falls back to the raw stored key when option metadata lacks the stored select value", () => {
    renderView({
      state: {
        status: "ready",
        items: [item({ properties: { name: "Dune", year: 2021, rating: 9, status: "archived" } })],
      },
    });

    expect(screen.getByText("archived")).toBeInTheDocument();
  });

  it("omits fields for missing optional keys/values and renders a valid source link", () => {
    renderView({
      state: {
        status: "ready",
        items: [
          item({
            properties: {
              name: "Dune",
              year: 2021,
              rating: 9,
              status: "watched",
              sourceUrl: "https://example.com/dune",
            },
          }),
        ],
      },
    });

    expect(screen.queryByText("Critics' rating")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://example.com/dune" })).toHaveAttribute(
      "href",
      "https://example.com/dune",
    );
  });

  it("omits the source link for an unsafe URL scheme instead of rendering it", () => {
    renderView({
      state: {
        status: "ready",
        items: [
          item({
            properties: {
              name: "Dune",
              year: 2021,
              rating: 9,
              status: "watched",
              sourceUrl: "javascript:alert(1)",
            },
          }),
        ],
      },
    });

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("falls back to the property's own label when the secondaryRatingLabel key has no translation", () => {
    renderView({
      contract: { ...CONTRACT, secondaryRatingLabel: "no.such.i18n.key" },
      properties: PROPERTIES.map((property) =>
        property.key === "secondaryRating" ? { ...property, label: "Critic score" } : property,
      ),
      state: {
        status: "ready",
        items: [
          item({
            properties: { name: "Dune", year: 2021, rating: 9, secondaryRating: 87, status: "watched" },
          }),
        ],
      },
    });

    expect(screen.getByText("Critic score")).toBeInTheDocument();
    expect(screen.queryByText("no.such.i18n.key")).not.toBeInTheDocument();
  });

  it("renders the fallback color and glyph for a malformed cover value", () => {
    renderView({
      state: {
        status: "ready",
        items: [
          item({ properties: { name: "Dune", year: 2021, rating: 9, status: "watched", cover: { wrong: "shape" } } }),
        ],
      },
    });

    const cover = screen.getByRole("img", { name: "Dune" });
    expect(cover.tagName).toBe("DIV");
    expect(cover).toHaveTextContent("\u{1F3AC}");
  });

  it("renders a valid cover from the authenticated inline blob URL", () => {
    renderView({
      state: {
        status: "ready",
        items: [
          item({ properties: { name: "Dune", year: 2021, rating: 9, status: "watched", cover: { blobId: "blob-1" } } }),
        ],
      },
    });

    const cover = screen.getByRole("img", { name: "Dune" });
    expect(cover.tagName).toBe("IMG");
    expect(cover).toHaveAttribute("src", "/api/blobs/blob-1?disposition=inline");
  });

  it("falls back when the blob image fails to load", () => {
    renderView({
      state: {
        status: "ready",
        items: [
          item({ properties: { name: "Dune", year: 2021, rating: 9, status: "watched", cover: { blobId: "blob-1" } } }),
        ],
      },
    });

    const img = screen.getByRole("img", { name: "Dune" });
    fireEvent.error(img);
    expect(screen.getByRole("img", { name: "Dune" }).tagName).toBe("DIV");
  });

  it("creates an item, disables the form while pending, and calls onCreated exactly once on success", async () => {
    const user = userEvent.setup();
    let resolveCreate: (value: Item) => void = () => {};
    const createItem = vi.fn(
      () =>
        new Promise<Item>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const onCreated = vi.fn();
    renderView({
      state: { status: "ready", items: [] },
      api: fakeApi({ createItem: createItem as unknown as AuthenticatedApiClient["createItem"] }),
      onCreated,
    });

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox"), "Dune");
    const submit = screen.getByRole("button", { name: "Add" });
    await user.click(submit);

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("form")).toHaveAttribute("aria-busy", "true");

    // A duplicate submit while pending is ignored.
    await user.click(submit);
    expect(createItem).toHaveBeenCalledTimes(1);
    expect(createItem).toHaveBeenCalledWith("db-1", { name: "Dune" });

    resolveCreate({
      id: "new-item",
      databaseId: "db-1",
      properties: { name: "Dune" },
      computed: {},
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    });

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "new-item" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("re-enables the form, retains the name, and announces failure without calling onCreated", async () => {
    const user = userEvent.setup();
    const createItem = vi.fn(async () => {
      throw new Error("boom");
    });
    const onCreated = vi.fn();
    renderView({
      state: { status: "ready", items: [] },
      api: fakeApi({ createItem: createItem as unknown as AuthenticatedApiClient["createItem"] }),
      onCreated,
    });

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox"), "Dune");
    await user.click(screen.getByRole("button", { name: "Add" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong. Try again.");
    expect(within(screen.getByRole("form")).getByRole("textbox")).toHaveValue("Dune");
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("does not show the Add action until the view is ready", () => {
    renderView({ state: { status: "loading" } });
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
  });
});
