import type { GuaranteeState } from "../contracts/control.js";

const INITIAL_GUARANTEE: GuaranteeState = Object.freeze({
  kind: "unverified",
  reason: "no-proxied-request-observed",
});

export class RuntimeGuarantee {
  #state: GuaranteeState;
  readonly #onChange?: (state: GuaranteeState) => void;

  constructor(
    initial: GuaranteeState = INITIAL_GUARANTEE,
    onChange?: (state: GuaranteeState) => void
  ) {
    this.#state = initial;
    this.#onChange = onChange;
  }

  current(): GuaranteeState {
    return this.#state;
  }

  markActive(lastAttemptId: string): void {
    if (!lastAttemptId || this.#state.kind === "rejected" || this.#state.kind === "bypass-explicit") {
      return;
    }
    this.#set(Object.freeze({ kind: "active", lastAttemptId }));
  }

  reject(reason: string): void {
    if (this.#state.kind === "bypass-explicit") return;
    this.#set(Object.freeze({ kind: "rejected", reason }));
  }

  #set(next: GuaranteeState): void {
    this.#state = next;
    this.#onChange?.(next);
  }
}

export function guaranteeLabel(state: GuaranteeState): string {
  switch (state.kind) {
    case "unverified":
      return "unverified — no proxied request observed yet";
    case "active":
      return `active — verified attempt ${state.lastAttemptId}`;
    case "rejected":
      return `rejected — ${state.reason}`;
    case "bypass-explicit":
      return "BYPASS — surgery explicitly disabled before launch";
  }
}
