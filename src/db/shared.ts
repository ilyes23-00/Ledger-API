export type DatabaseRow = Record<string, unknown>;

export type DatabaseQueryable = {
  query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: DatabaseRow[] }>;
};

export const queryOne = async <TRow extends DatabaseRow>(
  queryable: DatabaseQueryable,
  text: string,
  values: readonly unknown[],
): Promise<TRow | null> => {
  const result = await queryable.query(text, [...values]);
  const row = result.rows[0];
  return row === undefined ? null : (row as TRow);
};
