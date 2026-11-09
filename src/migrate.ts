import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";

const direction = process.argv[2] === "down" ? "down" : "up";

const orm = await MikroORM.init(config);
const migrator = orm.migrator;
if (direction === "down") {
  await migrator.down();
} else {
  await migrator.up();
}
await orm.close(true);
console.log(JSON.stringify({ message: `migrations ${direction} complete` }));
