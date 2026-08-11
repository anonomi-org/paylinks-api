// Every SQL statement this service runs lives here.
//
// Keeping them in one place is what makes them testable: the handlers call
// these functions, and so do the tests, so a test exercises the same query
// that production does rather than a copy of it that can drift.

/**
 * The subset of a pg client these functions need. Narrow on purpose - anything
 * that can run a parameterised query satisfies it, which is what lets the tests
 * drive the real queries against an in-process Postgres.
 */
export interface Queryable {
  query<R = any>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/** A client checked out of a pool, returned when the handler is done. */
export type PooledClient = Queryable & { release(): void };

/** Just enough of a pg Pool for the handlers, so tests can supply their own. */
export interface PoolLike {
  connect(): Promise<PooledClient>;
}

export type PaylinkMeta = {
  label: string | null;
  active: boolean;
  deleted_at: string | null;
};

export type PaylinkForRequest = PaylinkMeta & {
  gen_mode: string;
  min_index: number;
  max_index: number;
};

/**
 * No public address here on purpose. It is used to derive the pool and compute
 * the owner key, both before this row is written, and nothing reads it after.
 *
 * `ownerKeyHmac` is the peppered form from src/ownerKey.ts, never the value the
 * browser sent. The plain owner_key column is left NULL: it still exists so the
 * previous release keeps working, and a later migration drops it.
 */
export type NewPaylink = {
  label: string | null;
  genMode: string;
  minIndex: number;
  maxIndex: number;
  ownerKeyHmac: string;
};

/** Insert the paylink row and return its generated id. */
export async function insertPaylink(
  db: Queryable,
  p: NewPaylink,
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `
    INSERT INTO paylinks (
      label,
      gen_mode,
      min_index,
      max_index,
      owner_key_hmac
    )
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id
    `,
    [p.label, p.genMode, p.minIndex, p.maxIndex, p.ownerKeyHmac],
  );

  const id = res.rows[0]?.id;
  if (!id) throw new Error("Failed to create paylink");
  return id;
}

/**
 * Write a paylink's whole precomputed address pool.
 *
 * unnest keeps this to three bound parameters rather than three per address,
 * so a thousand-address pool is still a single statement.
 */
export async function insertSubaddresses(
  db: Queryable,
  paylinkId: string,
  entries: { index: number; address: string }[],
): Promise<void> {
  await db.query(
    `
    INSERT INTO paylink_subaddresses (paylink_id, subaddress_index, address)
    SELECT $1, idx, addr
    FROM unnest($2::int[], $3::text[]) AS t(idx, addr)
    `,
    [paylinkId, entries.map((e) => e.index), entries.map((e) => e.address)],
  );
}

/** Fields the public metadata endpoint needs. */
export async function findPaylinkMeta(
  db: Queryable,
  id: string,
): Promise<PaylinkMeta | null> {
  const res = await db.query<PaylinkMeta>(
    `
    SELECT label, active, deleted_at
    FROM paylinks
    WHERE id = $1
    LIMIT 1
    `,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Fields the donation endpoint needs. */
export async function findPaylinkForRequest(
  db: Queryable,
  id: string,
): Promise<PaylinkForRequest | null> {
  const res = await db.query<PaylinkForRequest>(
    `
    SELECT label, active, deleted_at, gen_mode, min_index, max_index
    FROM paylinks
    WHERE id = $1
    LIMIT 1
    `,
    [id],
  );
  return res.rows[0] ?? null;
}

/** One address out of a paylink's pool. Null if the index is not in it. */
export async function findSubaddress(
  db: Queryable,
  paylinkId: string,
  index: number,
): Promise<string | null> {
  const res = await db.query<{ address: string }>(
    `
    SELECT address
    FROM paylink_subaddresses
    WHERE paylink_id = $1 AND subaddress_index = $2
    LIMIT 1
    `,
    [paylinkId, index],
  );
  return res.rows[0]?.address ?? null;
}

/**
 * Delete one paylink, and only if the owner key matches. The address pool goes
 * with it through the foreign key's ON DELETE CASCADE.
 *
 * Matches on the peppered column only, so a row with a NULL owner_key_hmac
 * never matches. The backfill covers every pre-existing row; a NULL is a row
 * the previous release wrote after 004 ran, which is why the migration is
 * documented as needing the app stopped.
 */
export async function deletePaylinkByIdAndOwner(
  db: Queryable,
  id: string,
  ownerKeyHmac: string,
): Promise<void> {
  await db.query(
    `
    DELETE FROM paylinks
    WHERE id = $1 AND owner_key_hmac = $2
    `,
    [id, ownerKeyHmac],
  );
}

/** Delete every paylink belonging to an owner key. */
export async function deletePaylinksByOwner(
  db: Queryable,
  ownerKeyHmac: string,
): Promise<void> {
  await db.query(
    `
    DELETE FROM paylinks
    WHERE owner_key_hmac = $1
    `,
    [ownerKeyHmac],
  );
}
