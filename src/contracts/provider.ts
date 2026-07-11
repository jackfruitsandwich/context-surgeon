import type { ContextObject } from "../context/types.js";
import type { Occurrence, ResolvedIdentity, StateSnapshot } from "./state.js";
import type {
  CompiledRequest,
  ExactBody,
  ProviderKind,
  ProviderValidationReceipt,
  ReceivedRequest,
} from "./truth.js";

export type ProviderProjection = Readonly<{
  provider: ProviderKind;
  context: ContextObject;
  occurrences: readonly Occurrence[];
  itemOrderHash: string;
  protectedHashes: Readonly<Record<string, string>>;
}>;

export interface ProviderCodec {
  readonly provider: ProviderKind;
  parse(received: ReceivedRequest, identity: ResolvedIdentity): ProviderProjection;
  serialize(context: ContextObject): Readonly<Record<string, unknown>>;
  validate(input: {
    before: ProviderProjection;
    afterValue: Readonly<Record<string, unknown>>;
  }): ProviderValidationReceipt;
}

export interface RequestCompiler {
  compile(input: {
    received: ReceivedRequest;
    identity: ResolvedIdentity;
    state: StateSnapshot;
    codec: ProviderCodec;
  }): Readonly<{ compiled: CompiledRequest; exactBody: ExactBody }>;
}

