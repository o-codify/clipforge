import { defineConfig } from "drizzle-kit";

// Строка подключения берётся из окружения: в разработке из .env корня,
// в бою - из переменных среды. Хардкода нет нигде.
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://clipforge:clipforge@127.0.0.1:55432/clipforge",
  },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
