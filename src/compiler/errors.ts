import type { OperationResult } from "../contracts/truth.js";

export class TruthCoreError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly operationResults: readonly OperationResult[] = []
  ) {
    super(message);
    this.name = "TruthCoreError";
  }
}

export function truthError(error: unknown): TruthCoreError {
  if (error instanceof TruthCoreError) return error;
  return new TruthCoreError(
    error instanceof Error ? error.message : "Truth-core compilation failed",
    422,
    "compilation-failed"
  );
}
