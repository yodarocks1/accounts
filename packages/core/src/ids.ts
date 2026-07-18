/**
 * Platform-standard UUIDs via the Web Crypto global — available in Node ≥20
 * and every browser. This replaced `node:crypto` when the web UI arrived
 * (ADR 0020): the one portability edit core needed to run in a browser.
 * Declared locally because core's lib is ES2023 only (no DOM types).
 */
declare const crypto: { randomUUID(): string };

export function randomUUID(): string {
  return crypto.randomUUID();
}
