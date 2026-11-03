import { register } from "node:module";

register(new URL("./mailThreadBackfillDistResolver.mjs", import.meta.url));
await import("../../../dist/db/runMigrationsCli.js");
