import "server-only";

import type { AppDataSnapshot, DataSourceKind } from "../data-snapshot";

/**
 * Empty runtime state for a fresh installation.
 *
 * Business records are intentionally absent until they are returned by
 * PostgreSQL or written to the server-side local store. Test fixtures must
 * never be imported by this module.
 */
export function getEmptyDataSnapshot(source: DataSourceKind = "local"): AppDataSnapshot {
  return {
    source,
    products: [],
    knowledgeEntries: [],
    currencyRates: {},
    quoteHistory: [],
    adminUsers: [],
    aiLogs: [],
    qualityIssues: [],
    customers: [],
    followupTasks: [],
  };
}
