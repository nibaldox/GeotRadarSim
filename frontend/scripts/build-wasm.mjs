import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const rust = resolve(frontend, '../rust');
const target = resolve(process.env.CARGO_TARGET_DIR || resolve(rust, 'target'));
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: rust, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) { if (capture) console.error(result.stderr); process.exit(result.status ?? 1); }
  return result.stdout;
}
run('cargo', ['build', '-p', 'radar-wasm', '--release', '--target', 'wasm32-unknown-unknown']);
const lock = readFileSync(resolve(rust, 'Cargo.lock'), 'utf8');
const version = lock.match(/\[\[package\]\]\s+name = "wasm-bindgen"\s+version = "([^"]+)"/)?.[1];
const cli = run('wasm-bindgen', ['--version'], true).trim();
if (!version || cli !== `wasm-bindgen ${version}`) {
  console.error(`wasm-bindgen version mismatch: Cargo.lock=${version ?? 'missing'}, CLI=${cli}`);
  process.exit(1);
}
run('wasm-bindgen', ['--target', 'web', '--out-dir', resolve(frontend, 'src/wasm/pkg'), '--out-name', 'radar_wasm', resolve(target, 'wasm32-unknown-unknown/release/radar_wasm.wasm')]);
