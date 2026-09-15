import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/run/store/coordination-schema.ts",
  out: "./src/drizzle/coordination",
});
