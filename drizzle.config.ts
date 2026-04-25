import type { Config } from "drizzle-kit";

export default {
	schema: "./src/backend/persistence/db/schema.ts",
	out: "./src/backend/persistence/db/migrations",
	dialect: "sqlite",
} satisfies Config;
