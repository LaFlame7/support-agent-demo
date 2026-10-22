import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const schemaSql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

export interface OpenDbOptions {
  /** Real Postgres. Empty = embedded Postgres (PGlite). */
  url?: string;
  /** PGlite data directory. Empty = in-memory. */
  dir?: string;
  /** Postgres schema to use (lets tests share one server). */
  schema?: string;
}

export function openDb(opts: OpenDbOptions = {}): Promise<Db> {
  return opts.url ? openPg(opts.url, opts.schema) : openPglite(opts.dir);
}

async function openPglite(dir?: string): Promise<Db> {
  const lite = new PGlite(dir);
  await lite.exec(schemaSql);
  return {
    query: async (sql, params) => (await lite.query(sql, params)).rows as never,
    tx: (fn) => lite.transaction((tx) => fn({ query: async (sql, params) => (await tx.query(sql, params)).rows as never })),
    close: () => lite.close(),
  };
}

async function openPg(url: string, schema?: string): Promise<Db> {
  if (schema) {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create schema if not exists "${schema}"`);
    await admin.end();
  }
  const pool = new pg.Pool({
    connectionString: url,
    ...(schema && { options: `-c search_path="${schema}"` }),
  });
  await pool.query(schemaSql);
  const asQueryable = (c: pg.Pool | pg.PoolClient): Queryable => ({
    query: async (sql, params) => (await c.query(sql, params)).rows,
  });
  return {
    ...asQueryable(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(asQueryable(client));
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
