import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n/index.js";
import { OperationError } from "../../api/genericOperations.js";
import { ErrorState } from "../StateViews.js";

function renderError(error: OperationError, locale: "en" | "cs" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <ErrorState error={error} onRetry={() => undefined} />
    </I18nProvider>,
  );
}

describe("ErrorState", () => {
  afterEach(() => cleanup());

  it("shows the unavailable title and the status message for a 404, with no retry button", async () => {
    renderError(new OperationError("unavailable", "Request to /views/x failed with 404", 404));

    expect(await screen.findByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("The server answered with status 404")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Request to/)).not.toBeInTheDocument();
  });

  it("shows the error title and the status message for a 500, with a retry button", async () => {
    renderError(new OperationError("retryable", "Request to /x failed with 500", 500));

    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("The server answered with status 500")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows the transport message when the error has no status", async () => {
    renderError(new OperationError("retryable", "Failed to fetch"));

    expect(await screen.findByText("The server could not be reached")).toBeInTheDocument();
  });

  it("shows the Czech strings under the cs locale", async () => {
    renderError(new OperationError("unavailable", "Request to /views/x failed with 404", 404), "cs");

    expect(await screen.findByText("Není k dispozici")).toBeInTheDocument();
    expect(screen.getByText("Server odpověděl stavem 404")).toBeInTheDocument();
  });
});
