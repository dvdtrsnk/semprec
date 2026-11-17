import * as Y from "yjs";

/** Elements are structured data, never bitmaps, so agents read and write them like database rows. */
const ELEMENTS_MAP_NAME = "elements";

export const CANVAS_ELEMENT_TYPES = ["shape", "connector", "text", "drawing"] as const;
export type CanvasElementType = (typeof CANVAS_ELEMENT_TYPES)[number];

export interface CanvasElementInput {
  id: string;
  type: CanvasElementType;
  /** [x, y, width, height] */
  xywh: [number, number, number, number];
  /** Fractional z-order index: insert between two elements without renumbering. */
  index: string;
  fields?: Record<string, unknown>;
}

export type CanvasElementData = Record<string, unknown>;

function getElementsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(ELEMENTS_MAP_NAME);
}

function toElementData(element: Y.Map<unknown>): CanvasElementData {
  return Object.fromEntries(element.entries());
}

/** Must run inside `doc.transact(...)` so the resulting mutation is captured as a single `doc_updates` row. */
export function putCanvasElement(doc: Y.Doc, input: CanvasElementInput): void {
  const elements = getElementsMap(doc);
  let element = elements.get(input.id);
  if (!element) {
    element = new Y.Map();
    elements.set(input.id, element);
  }
  // Required fields last, so a caller field can never override id/type/xywh/index.
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    element.set(key, value);
  }
  element.set("id", input.id);
  element.set("type", input.type);
  element.set("xywh", input.xywh);
  element.set("index", input.index);
}

export function getCanvasElement(doc: Y.Doc, elementId: string): CanvasElementData | null {
  const element = getElementsMap(doc).get(elementId);
  return element ? toElementData(element) : null;
}

export function listCanvasElements(doc: Y.Doc): CanvasElementData[] {
  return Array.from(getElementsMap(doc).values()).map(toElementData);
}

/** Must run inside `doc.transact(...)`. */
export function deleteCanvasElement(doc: Y.Doc, elementId: string): void {
  getElementsMap(doc).delete(elementId);
}
