import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createHttpGenericOperations } from "./api/httpGenericOperations.js";
import { createAiUsageOperations } from "./api/aiUsageOperations.js";

/**
 * Composition root: which backend to talk to and which view to open come from the
 * environment and the URL, never from a component. `?page=ai-usage` routes to the System
 * page's Utilization graph (issue #121) instead of an item/view id — it isn't a choke-point
 * view, so it doesn't go through `?view=`.
 */
const params = new URLSearchParams(window.location.search);
const viewId = params.get("view") ?? "";
const page = params.get("page");
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";
const operations = createHttpGenericOperations({ baseUrl: apiBaseUrl });
const aiUsageOperations =
  page === "ai-usage"
    ? createAiUsageOperations({ baseUrl: apiBaseUrl, authToken: import.meta.env.VITE_SEMPREC_API_TOKEN ?? "" })
    : undefined;

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root container");

createRoot(container).render(
  <StrictMode>
    <App viewId={viewId} operations={operations} aiUsageOperations={aiUsageOperations} />
  </StrictMode>,
);
