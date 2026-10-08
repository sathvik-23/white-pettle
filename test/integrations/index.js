// Lets `node --test test/integrations/` work on Node 22: a directory argument is loaded as a module (this file),
// so import every *.test.mjs here. When this file is picked up by a glob instead (argv[1] = this file), do nothing.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
if (resolve(process.argv[1] || "") === here) {
  for (const f of readdirSync(here).filter((n) => n.endsWith(".test.mjs")).sort()) await import(pathToFileURL(resolve(here, f)).href);
}
