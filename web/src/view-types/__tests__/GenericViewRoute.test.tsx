import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GenericViewRoute } from "../GenericViewRoute.js";
import { ViewTypeRegistry } from "../registry.js";

describe("GenericViewRoute", () => {
  it("mounts the registered renderer with the view and database ids from the URL", () => {
    const viewRegistry = new ViewTypeRegistry();
    viewRegistry.register("library-grid", ({ viewId, databaseId }) => <p>{`${viewId}/${databaseId}`}</p>);

    render(<GenericViewRoute search="?view=view-1&database=db-1&type=library-grid" viewRegistry={viewRegistry} />);

    expect(screen.getByText("view-1/db-1")).toBeInTheDocument();
  });
});
