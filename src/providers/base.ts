import type { ProviderProjection } from "../contracts/provider.js";
import type {
  ProviderValidationReceipt,
  ReceivedRequest,
} from "../contracts/truth.js";
import type { ResolvedIdentity } from "../contracts/state.js";
import type { FormatAdapter } from "../context/types.js";
import {
  deepFreeze,
  protectedHashesMatch,
  type JsonRecord,
} from "./shared.js";

export abstract class BaseProviderCodec {
  protected constructor(protected readonly adapter: FormatAdapter) {}

  abstract readonly provider: ProviderProjection["provider"];

  parse(received: ReceivedRequest, identity: ResolvedIdentity): ProviderProjection {
    this.assertEnvelope(received.providerValue);
    const value = structuredClone(received.providerValue) as JsonRecord;
    const context = this.prepareContext(this.adapter.parse(value));
    const projection = this.project(value, context, identity);
    return Object.freeze({
      ...projection,
      context,
      occurrences: Object.freeze([...projection.occurrences]),
      protectedHashes: deepFreeze({ ...projection.protectedHashes }),
    });
  }

  serialize(context: ProviderProjection["context"]): Readonly<JsonRecord> {
    return this.adapter.serialize(context);
  }

  validate(input: {
    before: ProviderProjection;
    afterValue: Readonly<JsonRecord>;
  }): ProviderValidationReceipt {
    const errors: string[] = [];
    let after:
      | {
          itemCount: number;
          itemOrderHash: string;
          protectedHashes: Readonly<Record<string, string>>;
        }
      | undefined;
    try {
      this.assertEnvelope(input.afterValue);
      after = this.inspectStructure(input.afterValue, errors);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Provider validation failed");
    }

    const protectedMatch = after
      ? protectedHashesMatch(input.before.protectedHashes, after.protectedHashes)
      : false;
    if (after && after.itemCount !== this.itemCount(input.before)) {
      errors.push("Provider item count changed");
    }
    if (after && after.itemOrderHash !== input.before.itemOrderHash) {
      errors.push("Provider item order or structural identity changed");
    }
    if (!protectedMatch) {
      errors.push("Protected provider structure changed");
    }

    return Object.freeze({
      valid: errors.length === 0,
      itemCountBefore: this.itemCount(input.before),
      itemCountAfter: after?.itemCount ?? -1,
      orderHashBefore: input.before.itemOrderHash,
      orderHashAfter: after?.itemOrderHash ?? "invalid",
      protectedHashesMatch: protectedMatch,
      errors: Object.freeze(errors),
    });
  }

  protected abstract assertEnvelope(value: Readonly<JsonRecord>): void;
  protected abstract prepareContext(
    context: ProviderProjection["context"]
  ): ProviderProjection["context"];
  protected abstract project(
    value: Readonly<JsonRecord>,
    context: ProviderProjection["context"],
    identity: ResolvedIdentity
  ): Omit<ProviderProjection, "provider" | "context"> & {
    provider: ProviderProjection["provider"];
    itemCount: number;
  };
  protected abstract inspectStructure(
    value: Readonly<JsonRecord>,
    errors: string[]
  ): {
    itemCount: number;
    itemOrderHash: string;
    protectedHashes: Readonly<Record<string, string>>;
  };

  private itemCount(projection: ProviderProjection): number {
    const itemCount = (projection as ProviderProjection & { itemCount?: unknown })
      .itemCount;
    if (typeof itemCount !== "number") {
      throw new Error("Provider projection omitted its item count");
    }
    return itemCount;
  }
}
