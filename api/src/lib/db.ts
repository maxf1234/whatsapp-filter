import pg from "pg";
import { env } from "./env.ts";

/**
 * Every request runs inside a transaction that has assumed the `authenticated`
 * role and published its JWT claims to `request.jwt.claims`, which is what the
 * RLS policies read. The application never filters by account_id — if a query
 * would cross a tenant boundary, the database returns zero rows rather than
 * trusting us to have remembered a WHERE clause.
 */

export interface Claims {
  sub: string;
}

export interface Querier {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

// Timestamps come back as ISO strings rather than local-timezone Date objects.
pg.types.setTypeParser(1114, (v) => v);
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
// bigint: counts here are far below 2^53 and JSON has no bigint.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: env.databaseUrl, max: 10 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

async function inTransaction<T>(
  setup: (client: pg.PoolClient) => Promise<void>,
  fn: (q: Querier) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await setup(client);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Run as the caller. `set local` unwinds with the transaction, so a pooled connection cannot leak claims into the next request. */
export function asPrincipal<T>(claims: Claims, fn: (q: Querier) => Promise<T>): Promise<T> {
  return inTransaction(async (client) => {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
  }, fn);
}

/**
 * Run with RLS bypassed. Reserved for the paths that have no principal yet
 * (signup) or that act for every tenant at once (the worker). Each use should be
 * obvious and few — the worker is the only long-running one, and it is the only
 * thing in the system that can read session_auth_state.
 */
export function asService<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
  return inTransaction(async (client) => {
    await client.query("set local role service_role");
  }, fn);
}

/** Returns the single row, or undefined. Throws if the query matched more than one. */
export async function one<R extends pg.QueryResultRow>(
  q: Querier,
  text: string,
  values?: unknown[],
): Promise<R | undefined> {
  const result = await q.query<R>(text, values);
  if (result.rows.length > 1) {
    throw new Error(`expected at most one row, got ${result.rows.length}`);
  }
  return result.rows[0];
}

export async function many<R extends pg.QueryResultRow>(
  q: Querier,
  text: string,
  values?: unknown[],
): Promise<R[]> {
  return (await q.query<R>(text, values)).rows;
}
