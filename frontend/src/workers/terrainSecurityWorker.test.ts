import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DXF_ENTITIES, MAX_DXF_VERTICES, MAX_DXF_TEXT_BYTES, MAX_TERRAIN_FILE_BYTES } from '../utils/terrainLimits';

const parsed = vi.hoisted(() => ({ entities: [] as unknown[] }));
vi.mock('dxf-parser', () => ({ default: class { parseSync() { return parsed; } } }));
let handler: (event: MessageEvent) => Promise<void>;
let result: any;
beforeAll(async () => {
  (globalThis as any).self = { postMessage: (message: unknown) => { result = message; } };
  await import('./terrainWorker');
  handler = (globalThis as any).self.onmessage;
});
beforeEach(() => { parsed.entities = []; result = undefined; });
async function run(fileData: ArrayBuffer, filename = 'test.dxf') {
  await handler({ data: { fileData, filename, resolution: 1, mode: 'bounds' } } as MessageEvent);
  return result;
}
describe('defensa del worker de terreno', () => {
  it('rechaza un buffer mayor al límite general', async () => {
    expect((await run(new ArrayBuffer(MAX_TERRAIN_FILE_BYTES + 1), 'x.stl')).error).toMatch(/límite/);
  });
  it('rechaza un DXF mayor al límite de texto', async () => {
    expect((await run(new ArrayBuffer(MAX_DXF_TEXT_BYTES + 1))).error).toMatch(/DXF.*límite/);
  });
  it('rechaza entidades antes de generar puntos', async () => {
    parsed.entities = Array(MAX_DXF_ENTITIES + 1).fill({ type: 'POINT', position: {x: 0, y: 0, z: 0} });
    expect((await run(new ArrayBuffer(0))).error).toMatch(/entidades/);
  });
  it('rechaza los vértices acumulados antes de generar puntos', async () => {
    parsed.entities = [{ type: 'LWPOLYLINE', vertices: Array(MAX_DXF_VERTICES + 1).fill({x: 0, y: 0, z: 0}) }];
    expect((await run(new ArrayBuffer(0))).error).toMatch(/vértices/);
  });
});
