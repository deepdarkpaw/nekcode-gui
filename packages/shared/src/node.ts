/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
export { acquireFileLock } from "./node/atomicFileLock.js";
export {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
} from "./node/subagentMarkdownMigration.js";
export {
  migrateLegacyUserDataRoot,
  type MigrateLegacyUserDataRootOptions,
  type MigrateLegacyUserDataRootResult,
} from "./node/userDataRootMigration.js";
export {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  type SharedFileLockOptions,
} from "./node/privateFilePersistence.js";

export * from "./node/nodeSelfResourceTelemetry.js";
export * from "./node/diagnosticsExport.js";
