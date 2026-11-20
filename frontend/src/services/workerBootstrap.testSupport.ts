/**
 * Test support for Workers started by `createModuleWorker` (src/services/moduleWorker.ts).
 *
 * Those Workers are constructed with a `blob:` bootstrap URL, so a stubbed Worker only sees
 * `blob:…`. Importing this module records the Blob behind every `blob:` URL created afterwards
 * in the importing test file, so a test can read which Worker module a bootstrap imports.
 */
const bootstrapBlobs = new Map<string, Blob>();
const originalCreateObjectURL = URL.createObjectURL.bind(URL);

URL.createObjectURL = (object: Blob | MediaSource): string => {
  const url = originalCreateObjectURL(object);
  if (object instanceof Blob) bootstrapBlobs.set(url, object);
  return url;
};

/** The Blob behind a Worker's `blob:` bootstrap URL; throws if it was not created here. */
export function workerBootstrapBlob(workerUrl: URL | string): Blob {
  const blob = bootstrapBlobs.get(String(workerUrl));
  if (!blob) throw new Error(`No recorded bootstrap Blob for Worker URL ${String(workerUrl)}`);
  return blob;
}

/** The module specifier statically imported by a Worker's `blob:` bootstrap. */
export async function workerBootstrapImport(workerUrl: URL | string): Promise<string> {
  const source = await workerBootstrapBlob(workerUrl).text();
  const match = /^import ("(?:[^"\\]|\\.)*");\n/.exec(source);
  if (!match) throw new Error(`Worker bootstrap does not start with a static import: ${source}`);
  return JSON.parse(match[1]!) as string;
}
