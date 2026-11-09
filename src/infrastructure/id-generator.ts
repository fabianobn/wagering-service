import { Injectable } from "@nestjs/common";
import type { IdGenerator } from "../application/ports";

@Injectable()
export class UuidV7Generator implements IdGenerator {
  uuid(): string {
    return Bun.randomUUIDv7();
  }
}
