export function buildWhere(
  filters: Record<string, unknown>,
): { clause: string; values: unknown[]; paramOffset: number } {
  const parts: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const [col, val] of Object.entries(filters)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      // R3: an empty list means "match nothing". It used to be skipped, so
      // buildDelete("holds", { id: [] }) produced `DELETE FROM holds` with no
      // WHERE at all — every quiet night wiped the whole holds table.
      if (val.length === 0) {
        parts.push("FALSE");
        continue;
      }
      values.push(val);
      parts.push(`${col} = ANY($${idx}::uuid[])`);
      idx++;
    } else {
      values.push(val);
      parts.push(`${col} = $${idx}`);
      idx++;
    }
  }
  const clause = parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
  return { clause, values, paramOffset: idx };
}

export function buildDelete(
  table: string,
  filters: Record<string, unknown>,
): { text: string; values: unknown[] } {
  const { clause, values } = buildWhere(filters);
  // A DELETE with no predicate is never what a caller of this helper means.
  if (clause === "") {
    throw new Error(`buildDelete(${table}): refusing to build an unfiltered DELETE`);
  }
  return { text: `DELETE FROM ${table} ${clause}`.trim(), values };
}
