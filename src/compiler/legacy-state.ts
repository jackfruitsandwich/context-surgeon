import type { ProviderProjection } from "../contracts/provider.js";
import type { StateSnapshot, SurgeryAction, SurgeryRecord } from "../contracts/state.js";
import type { DirectiveStore } from "../store/directive-store.js";

export type LegacyStateBridge = Readonly<{
  state: StateSnapshot;
  matchedFingerprints: readonly string[];
}>;

export function legacyStateForProjection(input: {
  projection: ProviderProjection;
  directiveStore: DirectiveStore;
  sessionId: string;
  branchId: string;
}): LegacyStateBridge {
  const fingerprintByLabel = new Map<string, string>();
  for (const item of input.projection.context.items) {
    if (item.fingerprint) fingerprintByLabel.set(item.id, item.fingerprint);
  }

  const mediaIndexByFingerprintAndKind = new Map<string, number>();
  const surgeries: SurgeryRecord[] = [];
  const matched = new Set<string>();
  for (const occurrence of input.projection.occurrences) {
    const fingerprint = fingerprintByLabel.get(occurrence.displayLabel);
    if (!fingerprint) continue;
    const entry = input.directiveStore.get(fingerprint);
    if (!entry) continue;

    const directive = entry.directive;
    if (directive.type === "evict" && directive.mediaType) {
      if (occurrence.kind !== directive.mediaType) continue;
      const counterKey = `${fingerprint}:${occurrence.kind}`;
      const mediaIndex = (mediaIndexByFingerprintAndKind.get(counterKey) ?? 0) + 1;
      mediaIndexByFingerprintAndKind.set(counterKey, mediaIndex);
      if (
        directive.occurrences &&
        directive.occurrences.length > 0 &&
        !directive.occurrences.includes(mediaIndex)
      ) {
        continue;
      }
    }

    const action: SurgeryAction =
      directive.type === "replace"
        ? { kind: "replace", content: directive.content }
        : directive.mediaType
          ? { kind: "evict-media", mediaType: directive.mediaType }
          : { kind: "evict" };
    surgeries.push(
      Object.freeze({
        surgeryId: `legacy:${fingerprint}:${occurrence.occurrenceId}`,
        state: "committed" as const,
        branchId: input.branchId,
        occurrenceId: occurrence.occurrenceId,
        expectedSourceHash: occurrence.sourceHash,
        action,
        createdAt: new Date(entry.createdAt).toISOString(),
      })
    );
    matched.add(fingerprint);
  }

  return Object.freeze({
    state: Object.freeze({
      version: 3 as const,
      sessionId: input.sessionId,
      revision: 0,
      surgeries: Object.freeze(surgeries),
      receiptsByOperationId: Object.freeze({}),
    }),
    matchedFingerprints: Object.freeze([...matched]),
  });
}
