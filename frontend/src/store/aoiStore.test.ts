import { beforeEach, describe, expect, it } from 'vitest';
import { useAoiStore } from './aoiStore';
import { useTerrainStore } from './terrainStore';

describe('área ligada al terreno', () => {
  beforeEach(() => {
    useAoiStore.getState().clear();
    useTerrainStore.setState({ terrainKey: { terrain_id: 'a', epoch: 1 }, loading: false });
  });
  it('dibuja, cierra, edita y borra', () => {
    const s = useAoiStore.getState();
    s.startDrawing();
    s.addVertex({x: 0, y: 0}); s.addVertex({x: 4, y: 0}); s.addVertex({x: 0, y: 4});
    s.closePolygon();
    expect(useAoiStore.getState().polygon?.vertices).toHaveLength(3);
    s.moveVertex(1, {x: 5, y: 0});
    expect(useAoiStore.getState().polygon?.vertices[1]?.x).toBe(5);
    s.deleteVertex(1);
    expect(useAoiStore.getState().polygon?.vertices).toHaveLength(3);
    expect(useAoiStore.getState().error).toBeTruthy();
    s.clear(); expect(useAoiStore.getState().polygon).toBeNull();
  });
  it('mantiene el orden de edición y rechaza mover el último sobre el primero', () => {
    const s = useAoiStore.getState(); s.startDrawing();
    s.addVertex({x:0,y:0}); s.addVertex({x:2,y:0}); s.addVertex({x:0,y:2}); s.closePolygon();
    s.moveVertex(0, {x:0.25,y:0.25});
    s.moveVertex(0, {x:0.5,y:0.25});
    expect(useAoiStore.getState().vertices).toEqual([{x:0.5,y:0.25},{x:2,y:0},{x:0,y:2}]);
    expect(useAoiStore.getState().polygon?.vertices).toEqual([{x:0,y:2},{x:0.5,y:0.25},{x:2,y:0}]);
    const valid = useAoiStore.getState().polygon;
    s.moveVertex(2, {x:0.5,y:0.25});
    expect(useAoiStore.getState().vertices).toEqual([{x:0.5,y:0.25},{x:2,y:0},{x:0,y:2}]);
    expect(useAoiStore.getState().polygon).toEqual(valid);
    expect(useAoiStore.getState().error).toBeTruthy();
  });
  it('no interpreta la colisión del último vértice como cierre durante la edición', () => {
    const s = useAoiStore.getState(); s.startDrawing();
    s.addVertex({x:0,y:0}); s.addVertex({x:2,y:0}); s.addVertex({x:2,y:2}); s.addVertex({x:0,y:2}); s.closePolygon();
    const before = useAoiStore.getState();
    s.moveVertex(3, {x:0,y:0});
    expect(useAoiStore.getState().vertices).toEqual(before.vertices);
    expect(useAoiStore.getState().polygon).toEqual(before.polygon);
    expect(useAoiStore.getState().error).toBeTruthy();
  });
  it('acepta cierre explícito repetido solo al cerrar el dibujo', () => {
    const s = useAoiStore.getState(); s.startDrawing();
    s.addVertex({x:0,y:0}); s.addVertex({x:2,y:0}); s.addVertex({x:0,y:2}); s.addVertex({x:0,y:0}); s.closePolygon();
    expect(useAoiStore.getState().vertices).toEqual([{x:0,y:0},{x:2,y:0},{x:0,y:2}]);
    expect(useAoiStore.getState().polygon?.vertices).toHaveLength(3);
  });
  it('rechaza dos cierres repetidos sin publicar geometría inválida', () => {
    const s = useAoiStore.getState(); s.startDrawing();
    s.addVertex({x:0,y:0}); s.addVertex({x:2,y:0}); s.addVertex({x:0,y:2});
    s.addVertex({x:0,y:0}); s.addVertex({x:0,y:0}); s.closePolygon();
    expect(useAoiStore.getState().polygon).toBeNull();
    expect(useAoiStore.getState().error).toBeTruthy();
  });
  it('rechaza el polígono inválido y limpia al cambiar época', () => {
    const s = useAoiStore.getState(); s.startDrawing();
    s.addVertex({x: 0, y: 0}); s.addVertex({x: 1, y: 0}); s.addVertex({x: 2, y: 0}); s.closePolygon();
    expect(useAoiStore.getState().polygon).toBeNull(); expect(useAoiStore.getState().error).toBeTruthy();
    s.clear(); s.startDrawing(); s.addVertex({x: 0, y: 0}); s.addVertex({x: 1, y: 0}); s.addVertex({x: 0, y: 1}); s.closePolygon();
    useTerrainStore.setState({terrainKey: {terrain_id:'a', epoch:2}});
    expect(useAoiStore.getState().polygon).toBeNull();
  });
});
