// Minimal Node declarations used by this isolated harness; the project does not install @types/node.
declare const process: { env: Record<string, string | undefined>; version: string; versions: { v8: string } };
declare module 'node:crypto' {
  export function createHash(algorithm: string): { update(data: Uint8Array): { digest(encoding: 'hex'): string } };
}
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array;
  export function mkdirSync(path: string, options: { recursive: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
}
declare module 'node:os' {
  export function cpus(): { model: string }[];
  export function endianness(): string;
}
declare module 'node:child_process' {
  export function execFileSync(command: string, args: string[], options: { encoding: 'utf8' }): string;
}
declare module 'node:perf_hooks' { export const performance: { now(): number }; }
