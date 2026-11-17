import { assertCanWrite } from "./authorization.js";
import { insertItem } from "./itemsStore.js";

export const getItem = (): void => {
  assertCanWrite();
  insertItem();
};
