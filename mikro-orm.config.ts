import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { ormEntities } from "./src/infrastructure/persistence/orm-entities";

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? "postgresql://wager:wager@localhost:5432/wager",
  entities: ormEntities,
  extensions: [Migrator],
  migrations: {
    path: "./src/infrastructure/persistence/migrations",
    glob: "Migration*.ts",
    transactional: true,
    allOrNothing: true,
  },
  allowGlobalContext: true,
  forceUtcTimezone: true,
});
