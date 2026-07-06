import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    // Only needed by `drizzle-kit migrate` against a real database.
    url: process.env.DATABASE_URL ?? "",
  },
});
