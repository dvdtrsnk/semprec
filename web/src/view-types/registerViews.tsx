/* eslint-disable react-refresh/only-export-components -- this module deliberately performs the one-time renderer registration. */
import { registry } from "./registry.js";

function LibraryGridPlaceholder() {
  return null;
}

registry.register("library-grid", LibraryGridPlaceholder);
