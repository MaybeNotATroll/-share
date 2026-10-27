import type { SupabaseClient } from "@supabase/supabase-js";

export type BackendRow = Record<string, unknown>;

export function backendFixture(initial: BackendRow[] = []) {
  const rows = structuredClone(initial);
  const events: string[] = [];
  let unavailable = false;
  const value = (row: BackendRow, column: string): unknown => column.split(".")
    .reduce<unknown>((current, key) => (current as BackendRow)?.[key], row);
  const database = {
    from(table: string) {
      if (table !== "files") throw new Error(`Unexpected table ${table}`);
      const filters: ((row: BackendRow) => boolean)[] = [];
      const orders: { column: string; ascending: boolean }[] = [];
      let deleting = false;
      let single = false;
      let limit = Infinity;
      return {
        select() { return this; },
        delete() { deleting = true; return this; },
        eq(column: string, expected: unknown) {
          filters.push((row) => value(row, column) === expected); return this;
        },
        is(column: string, expected: unknown) {
          filters.push((row) => value(row, column) === expected); return this;
        },
        not(column: string, operator: string, expected: unknown) {
          if (operator !== "is") throw new Error("Unexpected operator");
          filters.push((row) => value(row, column) !== expected); return this;
        },
        gt(column: string, expected: string) {
          filters.push((row) => String(value(row, column)) > expected); return this;
        },
        order(column: string, options: { ascending: boolean }) {
          orders.push({ column, ...options }); return this;
        },
        limit(count: number) { limit = count; return this; },
        maybeSingle() { single = true; return this; },
        or(expression: string) {
          const match = /^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/.exec(expression);
          if (!match || match[1] !== match[2]) throw new Error("Unsafe cursor expression");
          filters.push((row) => String(row.created_at) < match[1] ||
            (row.created_at === match[1] && String(row.id) < match[3]));
          return this;
        },
        then(resolve: (result: { data: unknown; error: unknown }) => void) {
          if (unavailable) return resolve({ data: null, error: { code: "unavailable" } });
          const selected = rows.filter((row) => filters.every((filter) => filter(row)));
          selected.sort((left, right) => {
            for (const order of orders) {
              const a = String(value(left, order.column));
              const b = String(value(right, order.column));
              if (a !== b) return (a < b ? -1 : 1) * (order.ascending ? 1 : -1);
            }
            return 0;
          });
          const result = selected.slice(0, limit);
          if (deleting) {
            events.push("metadata-deleted-and-tombstoned");
            for (const row of result) rows.splice(rows.indexOf(row), 1);
          }
          resolve({ data: single ? result[0] ?? null : result, error: null });
        },
      };
    },
  };
  return {
    database: database as unknown as SupabaseClient, rows, events,
    failDatabase() { unavailable = true; },
  };
}
