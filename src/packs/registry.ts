/** Language-pack registry. New language = register a pack here; no engine change (ADR-0002). */

import type { LanguagePack } from "../interfaces/languagePack.js";
import { PythonPack } from "./python/index.js";
import { RustPack } from "./rust/index.js";
import { TypeScriptPack } from "./typescript/index.js";

const PACKS: LanguagePack[] = [new PythonPack(), new TypeScriptPack(), new RustPack()];

export function allPacks(): LanguagePack[] {
  return [...PACKS];
}

export function packForPath(path: string): LanguagePack | null {
  for (const pack of PACKS) if (pack.extensions.some((e) => path.endsWith(e))) return pack;
  return null;
}

export function packById(packId: string): LanguagePack | null {
  return PACKS.find((p) => p.id === packId) ?? null;
}
