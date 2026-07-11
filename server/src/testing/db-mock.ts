/* eslint-disable @typescript-eslint/no-explicit-any */
import { Db } from '../database/database.module';

/**
 * Minimal chainable Kysely query-builder stub for unit tests. Every builder
 * method (`values`, `where`, `select`, …) is a jest.fn that returns the same
 * builder, so calls can be inspected (e.g. what was passed to `.values()`),
 * while the terminal executors resolve to preconfigured results.
 */
export interface ChainTerminals {
  execute?: unknown;
  executeTakeFirst?: unknown;
  executeTakeFirstOrThrow?: unknown;
}

export type ChainBuilder = Record<string, jest.Mock>;

const CHAIN_METHODS = [
  'values',
  'set',
  'returning',
  'returningAll',
  'select',
  'selectAll',
  'where',
  'innerJoin',
  'leftJoin',
  'orderBy',
  'limit',
  'offset',
  'onConflict',
  'columns',
  'distinctOn',
  'groupBy',
  'having',
];

export function chain(terminals: ChainTerminals = {}): ChainBuilder {
  const builder: ChainBuilder = {};
  for (const method of CHAIN_METHODS) {
    builder[method] = jest.fn(() => builder);
  }
  builder.execute = jest.fn(() =>
    Promise.resolve('execute' in terminals ? terminals.execute : []),
  );
  builder.executeTakeFirst = jest.fn(() =>
    Promise.resolve(terminals.executeTakeFirst),
  );
  builder.executeTakeFirstOrThrow = jest.fn(() =>
    'executeTakeFirstOrThrow' in terminals
      ? Promise.resolve(terminals.executeTakeFirstOrThrow)
      : Promise.reject(new Error('executeTakeFirstOrThrow: no result configured')),
  );
  return builder;
}

/**
 * Builds a `Db` stub whose top-level operations return the given builders.
 * Each key maps an operation (`insertInto`, `selectFrom`, `updateTable`,
 * `deleteFrom`) to the chain builder returned for every call of that operation.
 */
export interface DbMock {
  db: Db;
  insertInto: jest.Mock;
  selectFrom: jest.Mock;
  updateTable: jest.Mock;
  deleteFrom: jest.Mock;
}

export function createDbMock(builders: {
  insertInto?: ChainBuilder;
  selectFrom?: ChainBuilder;
  updateTable?: ChainBuilder;
  deleteFrom?: ChainBuilder;
}): DbMock {
  const insertInto = jest.fn(() => builders.insertInto ?? chain());
  const selectFrom = jest.fn(() => builders.selectFrom ?? chain());
  const updateTable = jest.fn(() => builders.updateTable ?? chain());
  const deleteFrom = jest.fn(() => builders.deleteFrom ?? chain());
  const db = { insertInto, selectFrom, updateTable, deleteFrom } as unknown as Db;
  return { db, insertInto, selectFrom, updateTable, deleteFrom };
}

/** A base64 32-byte master key valid for CryptoService/config in tests. */
export const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
