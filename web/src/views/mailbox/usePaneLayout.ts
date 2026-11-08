import { useEffect, useState } from "react";

export type Pane = "folders" | "messages" | "message";

/**
 * Watches the single-pane breakpoint (the same value the stylesheet uses, kept here as the
 * media query the layout logic branches on). Narrow layouts — and every iOS phone width —
 * show one pane at a time; from the breakpoint up, all three are visible at once.
 */
export const PANES_MEDIA_QUERY = "(max-width: 900px)";

export function useIsNarrow(query: string = PANES_MEDIA_QUERY): boolean {
  const [isNarrow, setIsNarrow] = useState(() => globalThis.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (!list) return;
    setIsNarrow(list.matches);
    const onChange = (event: MediaQueryListEvent) => setIsNarrow(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return isNarrow;
}

/** The pane a narrow layout shows, derived from how far into the mailbox the user has gone. */
export function activePane(selection: { folderId: string | null; messageId: string | null }): Pane {
  if (selection.messageId) return "message";
  if (selection.folderId) return "messages";
  return "folders";
}

/** Where the back action returns to; `null` on the first pane, where there is no back. */
export function backTarget(pane: Pane): Pane | null {
  if (pane === "message") return "messages";
  if (pane === "messages") return "folders";
  return null;
}
