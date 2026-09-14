import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GenericViewRoute, resolveGenericViewRoute } from "../GenericViewRoute.js";
import { ViewTypeRegistry } from "../registry.js";

describe("GenericViewRoute", () => {
  it("mounts the registered renderer with the view and database ids from the URL", () => {
    const viewRegistry = new ViewTypeRegistry();
    viewRegistry.register("library-grid", ({ viewId, databaseId }) => <p>{`${viewId}/${databaseId}`}</p>);

    render(<GenericViewRoute search="?view=view-1&database=db-1&type=library-grid" viewRegistry={viewRegistry} />);

    expect(screen.getByText("view-1/db-1")).toBeInTheDocument();
  });

  it("does not resolve an incomplete generic view URL", () => {
    expect(resolveGenericViewRoute(new URLSearchParams("view=view-1&database=db-1"))).toBeNull();
  });

  it("renders nothing when the view type has no registered renderer", () => {
    const { container } = render(
      <GenericViewRoute search="?view=view-1&database=db-1&type=library-grid" viewRegistry={new ViewTypeRegistry()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
