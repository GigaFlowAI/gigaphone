// Copy non-TS assets tsc doesn't emit into dist/ after a build.
// The python language pack shells out to a bundled astDump.py resolved next to its module.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "dist", "packs", "python");
mkdirSync(dest, { recursive: true });
cpSync(join(root, "src", "packs", "python", "astDump.py"), join(dest, "astDump.py"));
console.log("copied astDump.py → dist/packs/python/");
