/**
 * The mailbox's single-key shortcuts (`j`/`k` to move the cursor, `e` to archive), resolved
 * from a raw keydown. They are document-level — a triage keystroke has to work while the
 * cursor sits on a message row, on the folder sidebar, or nowhere in particular — which is
 * exactly why they must go silent inside an editable control: a `j` typed into a search box
 * or a reply body is text, never a command.
 */
export type MailboxShortcut = "cursorNext" | "cursorPrevious" | "archive";

const SHORTCUTS: Record<string, MailboxShortcut> = {
  j: "cursorNext",
  k: "cursorPrevious",
  e: "archive",
};

/**
 * Input types that hold no text — a `j` pressed on one of them is not typing, so it stays a
 * shortcut. That matters directly here: the row selection checkboxes take focus when clicked,
 * and `e` right after ticking a few of them has to archive the selection.
 */
const NON_TEXT_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image"]);

/** True for anything the user can type into: text fields and `contenteditable` regions alike. */
export function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // The attribute as well as the property: `isContentEditable` is a rendering-dependent
  // computation, and not every DOM implementation reports it.
  if (target.isContentEditable || target.getAttribute("contenteditable") === "true") return true;
  const tag = target.tagName.toLowerCase();
  if (tag === "input") return !NON_TEXT_INPUT_TYPES.has((target as HTMLInputElement).type);
  return tag === "textarea" || tag === "select";
}

/**
 * The shortcut a keydown stands for, or `null` when it is not one. A modifier combination is
 * never a shortcut here — `Ctrl+E`/`Cmd+K` belong to the browser and the OS, not to us.
 */
export function resolveShortcut(event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"> & { target?: EventTarget | null }): MailboxShortcut | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (isEditableElement(event.target ?? null)) return null;
  return SHORTCUTS[event.key.toLowerCase()] ?? null;
}
