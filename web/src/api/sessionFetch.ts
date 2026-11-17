/**
 * Wraps `fetch` so that any 401 an adapter receives mid-session is reported to the app — which
 * reloads to a clean URL, so the next sign-in starts from a fresh app — before the response is handed back unchanged. Adapters
 * keep their own status handling; this only observes.
 */
export function createSessionFetch(
  onUnauthorized: () => void,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status === 401) onUnauthorized();
    return response;
  };
}
