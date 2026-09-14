import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedWebProvider } from "../../../authenticatedWebContext.js";
import type {
  AuthenticatedApiClient,
  Item,
  PropertyCatalog,
  View,
  ViewQuery,
} from "../../../api/authenticatedApiClient.js";
import { GenericViewRoute } from "../../GenericViewRoute.js";
import { LibraryGridViewContainer } from "../LibraryGridViewContainer.js";

const CONTRACT_CONFIG = {
  coverKey: "cover",
  subtitleKey: "year",
  ratingKey: "rating",
  statusKey: "status",
};

function view(config: Record<string, unknown> = CONTRACT_CONFIG): View {
  return { id: "view-1", databaseId: "db-1", type: "library-grid", name: "Movies/TV", config };
}

function catalog(statusLabel = "Status"): PropertyCatalog {
  return {
    properties: [
      {
        id: "p1",
        databaseId: "db-1",
        key: "name",
        type: "title",
        label: "Name",
        locked: true,
        owner: "user",
        ownerProcess: null,
        migrationStatus: "current",
      },
      {
        id: "p2",
        databaseId: "db-1",
        key: "year",
        type: "number",
        label: "Year",
        locked: false,
        owner: "user",
        ownerProcess: null,
        migrationStatus: "current",
      },
      {
        id: "p3",
        databaseId: "db-1",
        key: "rating",
        type: "number",
        label: "Rating",
        locked: false,
        owner: "user",
        ownerProcess: null,
        migrationStatus: "current",
      },
      {
        id: "p4",
        databaseId: "db-1",
        key: "status",
        type: "select",
        label: statusLabel,
        options: [{ key: "watched", label: "Watched" }],
        locked: false,
        owner: "user",
        ownerProcess: null,
        migrationStatus: "current",
      },
    ],
  };
}

function itemRow(id: string, name: string): Item {
  return {
    id,
    databaseId: "db-1",
    properties: { name, year: 2021, status: "watched" },
    computed: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function queryResult(items: Item[]): ViewQuery {
  return { items, nextCursor: null };
}

function fakeApi(overrides: Partial<AuthenticatedApiClient> = {}): AuthenticatedApiClient {
  return {
    getView: vi.fn(async () => view()),
    listProperties: vi.fn(async () => catalog("Name")),
    queryView: vi.fn(async () => queryResult([itemRow("item-1", "Dune")])),
    createItem: vi.fn(),
    blobUrl: vi.fn((blobId: string) => `/api/blobs/${blobId}?disposition=inline`),
    ...overrides,
  };
}

function LocaleSwitcher({ api, initialLocale }: { api: AuthenticatedApiClient; initialLocale: string }) {
  const [locale, setLocale] = useState(initialLocale);
  return (
    <AuthenticatedWebProvider value={{ user: { locale }, api }}>
      <button type="button" onClick={() => setLocale("en")}>
        switch to en
      </button>
      <button type="button" onClick={() => setLocale("cs")}>
        switch to cs
      </button>
      <LibraryGridViewContainer viewId="view-1" databaseId="db-1" />
    </AuthenticatedWebProvider>
  );
}

function renderContainer(api: AuthenticatedApiClient, wrapper?: ({ children }: { children: ReactNode }) => ReactNode) {
  const Wrapper =
    wrapper ??
    (({ children }: { children: ReactNode }) => (
      <AuthenticatedWebProvider value={{ user: { locale: "en" }, api }}>{children}</AuthenticatedWebProvider>
    ));
  return render(<LibraryGridViewContainer viewId="view-1" databaseId="db-1" />, { wrapper: Wrapper });
}

describe("LibraryGridViewContainer", () => {
  it("fetches the view, properties, and first item page concurrently and renders ready", async () => {
    const api = fakeApi();
    renderContainer(api);

    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument());

    expect(api.getView).toHaveBeenCalledWith("view-1");
    expect(api.listProperties).toHaveBeenCalledWith("db-1");
    expect(api.queryView).toHaveBeenCalledWith("view-1", { cursor: null, limit: 50 });
  });

  it("enters the error state when the view's config fails the library-grid contract", async () => {
    const api = fakeApi({ getView: vi.fn(async () => view({ notAContract: true })) });
    renderContainer(api);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("enters the error state on a stable query failure code", async () => {
    const api = fakeApi({ queryView: vi.fn(async () => ({ code: "not_found" })) });
    renderContainer(api);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("reconciles the onCreated item into the ready list without a second GET", async () => {
    const user = userEvent.setup();
    const createItem = vi.fn(async () => itemRow("item-2", "Chinatown"));
    const api = fakeApi({ createItem: createItem as unknown as AuthenticatedApiClient["createItem"] });
    renderContainer(api);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument());
    expect(api.queryView).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox"), "Chinatown");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Chinatown" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument();
    expect(api.queryView).toHaveBeenCalledTimes(1);
  });

  it("a locale change after a failed initial load does not overwrite the error state", async () => {
    const api = fakeApi({ getView: vi.fn(async () => view({ notAContract: true })) });
    render(<LocaleSwitcher api={api} initialLocale="en" />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(api.listProperties).toHaveBeenCalledTimes(1);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "switch to cs" }));

    // The locale-only effect bails out instead of re-fetching properties and clobbering the error.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.listProperties).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("No items yet.")).not.toBeInTheDocument();
  });

  it("picks up a locale change that arrives during the initial load once it settles, instead of dropping it", async () => {
    let resolveQuery: (value: ViewQuery) => void = () => {};
    const queryView = vi.fn(() => new Promise<ViewQuery>((resolve) => (resolveQuery = resolve)));
    const listProperties = vi
      .fn()
      .mockResolvedValueOnce(catalog("Status (en)"))
      .mockResolvedValueOnce(catalog("Status (cs)"));
    const api = fakeApi({
      queryView: queryView as unknown as AuthenticatedApiClient["queryView"],
      listProperties: listProperties as unknown as AuthenticatedApiClient["listProperties"],
    });
    render(<LocaleSwitcher api={api} initialLocale="en" />);

    // The initial load is still in flight (queryView hasn't resolved yet).
    expect(screen.getByRole("status")).toHaveTextContent("Loading");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "switch to cs" }));

    // The locale effect defers instead of racing the still-loading initial load.
    expect(listProperties).toHaveBeenCalledTimes(1);

    resolveQuery(queryResult([itemRow("item-1", "Dune")]));

    await waitFor(() => expect(listProperties).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Status (cs)")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument();
  });

  it("re-resolves only the property catalog on a locale change, not the view or items", async () => {
    const api = fakeApi();
    render(<LocaleSwitcher api={api} initialLocale="en" />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument());
    expect(api.getView).toHaveBeenCalledTimes(1);
    expect(api.queryView).toHaveBeenCalledTimes(1);
    expect(api.listProperties).toHaveBeenCalledTimes(1);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "switch to cs" }));

    await waitFor(() => expect(api.listProperties).toHaveBeenCalledTimes(2));
    expect(api.getView).toHaveBeenCalledTimes(1);
    expect(api.queryView).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument());
  });

  it("a cs→en race: a delayed Czech catalog response cannot overwrite the later English catalog", async () => {
    let resolveCs: (value: PropertyCatalog) => void = () => {};
    const listProperties = vi
      .fn()
      .mockResolvedValueOnce(catalog("Status (en)"))
      .mockImplementationOnce(
        () =>
          new Promise<PropertyCatalog>((resolve) => {
            resolveCs = resolve;
          }),
      )
      .mockResolvedValueOnce(catalog("Status (en-2)"));
    const api = fakeApi({ listProperties: listProperties as unknown as AuthenticatedApiClient["listProperties"] });
    render(<LocaleSwitcher api={api} initialLocale="en" />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument());

    const user = userEvent.setup();
    // en -> cs starts the delayed request (held open by resolveCs).
    await user.click(screen.getByRole("button", { name: "switch to cs" }));
    // cs -> en starts and resolves a second, later request before the delayed cs one resolves.
    await user.click(screen.getByRole("button", { name: "switch to en" }));

    await waitFor(() => expect(listProperties).toHaveBeenCalledTimes(3));

    await waitFor(() => expect(screen.getByText("Status (en-2)")).toBeInTheDocument());

    // The stale cs response now resolves after the later en response already committed.
    resolveCs(catalog("Status (cs, stale)"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText("Status (en-2)")).toBeInTheDocument();
    expect(screen.queryByText("Status (cs, stale)")).not.toBeInTheDocument();
  });

  it.each(["en", "cs"] as const)(
    "dispatches to this container through GenericViewRoute and the real registry under locale %s",
    async (locale) => {
      const api = fakeApi();
      render(
        <AuthenticatedWebProvider value={{ user: { locale }, api }}>
          <GenericViewRoute search="?view=view-1&database=db-1&type=library-grid" />
        </AuthenticatedWebProvider>,
      );

      await waitFor(() => expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument());
      expect(api.getView).toHaveBeenCalledWith("view-1");
      expect(api.listProperties).toHaveBeenCalledWith("db-1");
      expect(api.queryView).toHaveBeenCalledWith("view-1", { cursor: null, limit: 50 });
    },
  );
});
