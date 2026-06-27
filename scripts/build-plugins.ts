/**
 * Regenerate the committed harness plugin files from the single manifest source, and verify
 * freshness in CI. Mirrors the engine's packaging module (the single source of truth).
 *
 *   npx tsx scripts/build-plugins.ts            # write the generated files
 *   npx tsx scripts/build-plugins.ts --check    # CI/release gate: exit 1 if stale
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommitted, write } from "../src/adapters/harness/packaging.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function main(argv: string[]): number {
  if (argv.includes("--check")) {
    const stale = checkCommitted(ROOT);
    if (stale.length) {
      process.stdout.write("stale plugin files (run `npx tsx scripts/build-plugins.ts`):\n");
      for (const rel of stale) process.stdout.write(`  - ${rel}\n`);
      return 1;
    }
    process.stdout.write("plugin files are up to date\n");
    return 0;
  }
  const written = write(ROOT);
  process.stdout.write(`built: ${written.join(", ")}, skills/gigaphone/\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
