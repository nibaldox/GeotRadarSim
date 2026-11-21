import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const rust = resolve(frontend, '../rust');
const target = resolve(process.env.CARGO_TARGET_DIR || resolve(rust, 'target'));
const repo = resolve(frontend, '..');
const remaps = [
  [resolve(process.env.CARGO_HOME || resolve(homedir(), '.cargo')), '/cargo'],
  [repo, '/src'],
  [resolve(process.env.RUSTUP_HOME || resolve(homedir(), '.rustup')), '/rustup'],
].map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
// Cargo gives CARGO_ENCODED_RUSTFLAGS precedence over RUSTFLAGS; preserve either form.
const originalRustflags = process.env.RUSTFLAGS || '';
process.env.RUSTFLAGS = [originalRustflags, ...remaps].filter(Boolean).join(' ');
if (process.env.CARGO_ENCODED_RUSTFLAGS !== undefined) {
  process.env.CARGO_ENCODED_RUSTFLAGS = [process.env.CARGO_ENCODED_RUSTFLAGS, ...remaps].filter(Boolean).join('\x1f');
} else {
  // Encode the existing whitespace-separated flags so remap paths can contain spaces.
  process.env.CARGO_ENCODED_RUSTFLAGS = [...originalRustflags.split(/\s+/).filter(Boolean), ...remaps].join('\x1f');
}
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: rust, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) { if (capture) console.error(result.stderr); process.exit(result.status ?? 1); }
  return result.stdout;
}
run('cargo', ['build', '-p', 'radar-wasm', '--release', '--locked', '--target', 'wasm32-unknown-unknown']);
const lock = readFileSync(resolve(rust, 'Cargo.lock'), 'utf8');
const version = lock.match(/\[\[package\]\]\s+name = "wasm-bindgen"\s+version = "([^"]+)"/)?.[1];
const cli = run('wasm-bindgen', ['--version'], true).trim();
if (!version || cli !== `wasm-bindgen ${version}`) {
  console.error(`wasm-bindgen version mismatch: Cargo.lock=${version ?? 'missing'}, CLI=${cli}`);
  process.exit(1);
}
run('wasm-bindgen', ['--target', 'web', '--out-dir', resolve(frontend, 'src/wasm/pkg'), '--out-name', 'radar_wasm', resolve(target, 'wasm32-unknown-unknown/release/radar_wasm.wasm')]);
const wasm = readFileSync(resolve(frontend, 'src/wasm/pkg/radar_wasm_bg.wasm'));
for (const path of ['/home/', '/Users/', 'C:\\Users', repo]) {
  if (wasm.includes(Buffer.from(path))) {
    console.error(`WASM contains a host path (${path}); refusing build`);
    process.exit(1);
  }
}
