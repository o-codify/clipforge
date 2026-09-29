/**
 * Подключение к базе.
 *
 * Одно соединение на процесс, а не на запрос: Postgres, в отличие от
 * SQLite, не привязывает соединение к потоку, и городить открытие на
 * каждый обработчик больше незачем.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseOptions {
  url: string;
  /** Пул: воркеры и API живут в разных процессах, каждому хватает немного. */
  max?: number;
  /** Печатать SQL. Полезно, когда запрос отдаёт не то, что ожидалось. */
  debug?: boolean;
}

export function createDatabase(options: DatabaseOptions) {
  const sql = postgres(options.url, {
    max: options.max ?? 10,
    connect_timeout: 5,
    // Имена в схеме camelCase, в базе snake_case. Преобразование здесь,
    // чтобы в запросах не мелькали кавычки и подчёркивания.
    // Only SQL column names are snake_case. JSON keys include opaque clip IDs,
    // Twitch logins and model payload fields; rewriting them corrupts lookups.
    transform: { column: postgres.camel.column },
    onnotice: () => {},
  });

  const db = drizzle(sql, { schema, logger: options.debug ?? false });
  return Object.assign(db, {
    /** Закрыть соединения. Нужно для тестов и штатной остановки. */
    async close() {
      await sql.end({ timeout: 5 });
    },
    sql,
  });
}
