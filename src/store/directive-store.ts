import type { Directive } from "../context/types.js";

export class DirectiveStore {
  private directives = new Map<string, Directive>();

  set(id: string, directive: Directive): void {
    this.directives.set(id, directive);
  }

  get(id: string): Directive | undefined {
    return this.directives.get(id);
  }

  has(id: string): boolean {
    return this.directives.has(id);
  }

  delete(id: string): boolean {
    return this.directives.delete(id);
  }

  getAll(): Map<string, Directive> {
    return new Map(this.directives);
  }

  size(): number {
    return this.directives.size;
  }

  clear(): void {
    this.directives.clear();
  }
}
