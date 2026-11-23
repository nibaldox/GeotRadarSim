import { create } from 'zustand';
import { AoiError, validateAoiPolygon } from '../utils/aoi';
import type { AoiPolygon, AoiVertex } from '../utils/aoi';
import type { TerrainKey } from './analysisStore';
import { useTerrainStore } from './terrainStore';

const message = (error: unknown): string => {
  if (error instanceof AoiError) {
    switch (error.code) {
      case 'AOI_TOO_FEW_VERTICES': return 'Se necesitan al menos tres vértices.';
      case 'AOI_TOO_MANY_VERTICES': return 'El área tiene demasiados vértices.';
      case 'AOI_DUPLICATE_VERTEX': return 'El área tiene vértices repetidos.';
      case 'AOI_SELF_INTERSECTION': return 'Los bordes del área se cruzan.';
      case 'AOI_ZERO_AREA': return 'El área no puede ser una línea.';
      case 'AOI_NON_FINITE': return 'Hay coordenadas inválidas.';
    }
  }
  return 'El área no es válida.';
};
interface State {
  polygon: AoiPolygon | null; vertices: readonly AoiVertex[]; terrainKey: TerrainKey | null;
  drawing: boolean; error: string | null;
  startDrawing: () => void; addVertex: (v: AoiVertex) => void; closePolygon: () => void;
  moveVertex: (i: number, v: AoiVertex) => void; deleteVertex: (i: number) => void; clear: () => void;
}
const empty = { polygon: null, vertices: [], terrainKey: null, drawing: false, error: null };
export const useAoiStore = create<State>((set, get) => {
  const commit = (vertices: readonly AoiVertex[], closing = false) => {
    try {
      const first = vertices[0];
      const last = vertices[vertices.length - 1];
      const repeatedClosingVertex = vertices.length >= 2 && !!first && !!last && first.x === last.x && first.y === last.y;
      if (repeatedClosingVertex && !closing) {
        throw new AoiError('AOI_DUPLICATE_VERTEX', 'AOI vertices coincide');
      }
      const editingVertices = repeatedClosingVertex ? vertices.slice(0, -1) : [...vertices];
      const valid = validateAoiPolygon({vertices});
      // Keep stable handle indices while the analysis polygon uses canonical order.
      set({polygon: {vertices: valid.vertices}, vertices: editingVertices, drawing: false, error: null});
    } catch (e) { set({error: message(e)}); }
  };
  return {
    ...empty,
    startDrawing: () => { const t = useTerrainStore.getState(); if (!t.terrainKey || t.loading) return; set({...empty, terrainKey: {...t.terrainKey}, drawing: true}); },
    addVertex: (v) => { if (get().drawing) { if (get().vertices.length >= 64) set({error: 'El área tiene demasiados vértices.'}); else set({vertices: [...get().vertices, v], error: null}); } },
    closePolygon: () => { if (get().drawing) commit(get().vertices, true); },
    moveVertex: (i, v) => { const s = get(); if (!s.polygon || i < 0 || i >= s.vertices.length) return; commit(s.vertices.map((p,j) => j === i ? v : p)); },
    deleteVertex: (i) => { const s = get(); if (!s.polygon || i < 0 || i >= s.vertices.length) return; commit(s.vertices.filter((_,j) => j !== i)); },
    clear: () => set(empty),
  };
});
useTerrainStore.subscribe((state) => {
  const aoi = useAoiStore.getState(); const key = state.terrainKey;
  if (aoi.terrainKey && (state.loading || !key || key.terrain_id !== aoi.terrainKey.terrain_id || key.epoch !== aoi.terrainKey.epoch)) aoi.clear();
});
