/**
 * GigaPhone library entry — the neutral core model, interfaces, engine, and registries.
 *
 * Trace-coverage instrumentation for AI agent codebases (neutral across harness, language,
 * vendor, codebase).
 */

// Core model + boundary vocabulary
export * from "./core/boundary.js";
export * from "./core/model.js";
export { PlanRecord, type PlanRecordDict, type PlanRecordInit } from "./core/planRecord.js";

// Axis interfaces
export * from "./interfaces/index.js";

// Engine orchestration
export * as engine from "./engine/index.js";

// Registries
export { allPacks, packForPath, packById } from "./packs/registry.js";
export { backendById, selectBackend } from "./adapters/backend/registry.js";
export {
  adapterById as codebaseAdapterById,
  bundledAdapters as bundledCodebaseAdapters,
  detectAdapters as detectCodebaseAdapters,
  loadRepoAdapter as loadRepoCodebaseAdapter,
  SCAFFOLD_FILENAME,
  scaffoldSource as scaffoldCodebaseAdapter,
} from "./adapters/codebase/index.js";

// Config I/O
export * as config from "./config/config.js";
