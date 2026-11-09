import { Injectable } from "@nestjs/common";

type LogFields = Record<string, unknown>;

@Injectable()
export class AppLogger {
  info(message: string, fields: LogFields = {}): void {
    this.write("info", message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write("error", message, fields);
  }

  private write(level: string, message: string, fields: LogFields): void {
    const payload = sanitize({
      level,
      message,
      time: new Date().toISOString(),
      ...fields,
    });
    console.log(JSON.stringify(payload));
  }
}

const SENSITIVE = new Set(["amount", "money", "balance", "payload", "initialBalance", "storedBalance", "calculatedBalance"]);

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE.has(key)) {
        result[key] = "[redacted]";
      } else {
        result[key] = sanitize(nested);
      }
    }
    return result;
  }
  return value;
}
