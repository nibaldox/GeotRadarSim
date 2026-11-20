import { describe, expect, it } from 'vitest';
import { MAX_TERRAIN_FILE_BYTES, MAX_DXF_ENTITIES, MAX_DXF_VERTICES, validateTerrainFileSize, validateDxfComplexity } from '../utils/terrainLimits';

describe('límites de importación', () => {
  it('acepta el tamaño exacto del límite', () => {
    expect(() => validateTerrainFileSize(MAX_TERRAIN_FILE_BYTES)).not.toThrow();
  });
  it('rechaza un byte por encima del límite', () => {
    expect(() => validateTerrainFileSize(MAX_TERRAIN_FILE_BYTES + 1)).toThrow(/MB/);
  });
  it('rechaza demasiadas entidades DXF', () => {
    expect(() => validateDxfComplexity(MAX_DXF_ENTITIES + 1, 0)).toThrow(/entidades/);
  });
  it('rechaza demasiados vértices DXF acumulados', () => {
    expect(() => validateDxfComplexity(1, MAX_DXF_VERTICES + 1)).toThrow(/vértices/);
  });
});
