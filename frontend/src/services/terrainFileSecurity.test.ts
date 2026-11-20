import { describe, expect, it, vi } from 'vitest';
import { previewTerrainBounds, uploadDXF, uploadSTL } from './api';
import { MAX_TERRAIN_FILE_BYTES } from '../utils/terrainLimits';

describe('límite antes de leer un terreno', () => {
  for (const [name, upload] of [['DXF', uploadDXF], ['STL', uploadSTL], ['vista previa', previewTerrainBounds]] as const) {
    it(`rechaza ${name} sin invocar arrayBuffer`, async () => {
      const arrayBuffer = vi.fn();
      const file = { name: 'oversize.stl', size: MAX_TERRAIN_FILE_BYTES + 1, arrayBuffer } as unknown as File;
      await expect(upload(file)).rejects.toThrow(/límite/);
      expect(arrayBuffer).not.toHaveBeenCalled();
    });
  }
});
