import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/run/store/run-schema.ts",
  out: "./src/drizzle/run",
});
