import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createHttpGenericOperations } from "./api/httpGenericOperations.js";

/**
 * Composition root: which backend to talk to and which view to open come from the
 * environment and the URL, never from a component.
 */
const params = new URLSearchParams(window.location.search);
const viewId = params.get("view") ?? "";
const operations = createHttpGenericOperations({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? "/api" });

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root container");

createRoot(container).render(
  <StrictMode>
    <App viewId={viewId} operations={operations} />
  </StrictMode>,
);
