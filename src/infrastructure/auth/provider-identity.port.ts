import { Injectable } from "@nestjs/common";

export abstract class ProviderIdentityPort {
  abstract resolveProviderId(_request: unknown): string | undefined;
}

@Injectable()
export class NoOpProviderIdentity implements ProviderIdentityPort {
  resolveProviderId(_request: unknown): string | undefined {
    return undefined;
  }
}
