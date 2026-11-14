import {
  CompiledQuery,
  DatabaseConnection,
  Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  QueryResult,
} from 'kysely';
import { Db } from '../database/database.module';
import { Database } from '../database/database.types';

export interface RecordedQuery {
  sql: string;
  parameters: readonly unknown[];
}

/**
 * A real Kysely (Postgres compiler) whose driver records every query instead
 * of sending it, answering each with the rows `respond` returns. Lets a test
 * check the SQL a service builds — joins, conditions, parameters — without a
 * database.
 */
export function recordingDb(
  respond: (query: RecordedQuery) => Record<string, unknown>[] = () => [],
): { db: Db; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const query = { sql: compiled.sql, parameters: compiled.parameters };
      queries.push(query);
      const rows = respond(query) as R[];
      return { rows, numAffectedRows: BigInt(rows.length) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error('streaming is not supported by the recording driver');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }) as unknown as Db;
  return { db, queries };
}
