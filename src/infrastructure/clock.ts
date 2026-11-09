import { Injectable } from "@nestjs/common";
import type { Clock } from "../application/ports";

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
