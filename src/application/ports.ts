export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuid(): string;
}

export interface PayloadHasher {
  hash(value: unknown): string;
}
