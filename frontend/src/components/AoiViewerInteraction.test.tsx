import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as THREE from 'three';
import { TerrainViewer } from './TerrainViewer';
import { useTerrainStore } from '../store/terrainStore';
import { useAoiStore } from '../store/aoiStore';

vi.mock('@react-three/fiber', async () => {
  const React = await import('react');
  const three = await import('three');
  const canvas = document.createElement('canvas');
  const camera = new three.PerspectiveCamera();
  const terrain = new three.Mesh();
  return {
    Canvas: ({children}: {children: import('react').ReactNode}) => React.createElement('div', {'data-testid':'scene'}, children),
    useThree: () => ({camera, gl:{domElement:canvas}, scene:{getObjectByName:()=>terrain}}),
  };
});
vi.mock('@react-three/drei', () => ({OrbitControls:()=>null,GizmoHelper:()=>null,GizmoViewport:()=>null,Line:()=>null}));

const pointEvent = (x: number, z: number, detail = 1) => ({ point:{x,y:0,z}, nativeEvent:{detail}, delta:0, stopPropagation:()=>{} });
function props(element: Element): Record<string, (e: any)=>void> {
  const key = Object.keys(element).find(k=>k.startsWith('__reactProps$'))!;
  return (element as unknown as Record<string, Record<string, (e: any)=>void>>)[key]!;
}

describe('interacciones de área en el visor', () => {
  beforeEach(() => {
    useAoiStore.getState().clear();
    useTerrainStore.setState({grid:[[0,0,0],[0,0,0],[0,0,0]], metadata:{terrain_id:'area-test',bounds:{min_x:0,min_y:0,min_z:0,max_x:2,max_y:2,max_z:0},resolution:1,grid_rows:3,grid_cols:3}, terrainKey:{terrain_id:'area-test',epoch:1},loading:false});
  });
  it('agrega vértices, cierra, arrastra y borra', async () => {
    vi.spyOn(THREE.Raycaster.prototype,'setFromCamera').mockImplementation(()=>{});
    const intersect = vi.spyOn(THREE.Raycaster.prototype,'intersectObject');
    intersect.mockReturnValue([{point:new THREE.Vector3(0.25,0,-0.25)}] as THREE.Intersection[]);
    const {container} = render(<TerrainViewer />);
    fireEvent.click(screen.getByRole('button',{name:'Área a monitorear'}));
    const mesh = container.querySelector('mesh[name="aoi-terrain-mesh"]')!;
    act(()=>{ props(mesh).onClick!(pointEvent(0,0)); props(mesh).onClick!(pointEvent(2,0)); props(mesh).onClick!(pointEvent(0,-2)); });
    expect(useAoiStore.getState().vertices).toHaveLength(3);
    act(()=>props(mesh).onDoubleClick!(pointEvent(0,-2,2)));
    expect(useAoiStore.getState().polygon).not.toBeNull();
    const handle = container.querySelector('mesh[position]');
    expect(handle).not.toBeNull();
    act(()=>props(handle!).onPointerDown!({stopPropagation:()=>{}}));
    const fiber = await import('@react-three/fiber');
    const gl = fiber.useThree().gl;
    act(()=>{ fireEvent.pointerMove(gl.domElement,{clientX:10,clientY:10}); });
    intersect.mockReturnValue([{point:new THREE.Vector3(0.5,0,-0.25)}] as THREE.Intersection[]);
    act(()=>{ fireEvent.pointerMove(gl.domElement,{clientX:20,clientY:10}); fireEvent.pointerUp(window); });
    expect(useAoiStore.getState().polygon?.vertices).toHaveLength(3);
    expect(useAoiStore.getState().polygon?.vertices).toEqual(expect.arrayContaining([
      {x:0.5,y:0.25}, {x:2,y:0}, {x:0,y:2},
    ]));
    fireEvent.click(screen.getByRole('button',{name:'Borrar área'}));
    expect(useAoiStore.getState().polygon).toBeNull();
    vi.restoreAllMocks();
  });
  it('identifica Borrar área como botón de barra con ícono', () => {
    render(<TerrainViewer />);
    fireEvent.click(screen.getByRole('button',{name:'Área a monitorear'}));
    const clear = screen.getByRole('button',{name:'Borrar área'});
    expect(clear).toHaveAttribute('aria-label', 'Borrar área');
    expect(clear).toHaveAttribute('title', 'Borrar área');
    expect(clear.querySelector('svg')).toBeInTheDocument();
  });
  it('Esc cancela el dibujo', () => {
    const {container} = render(<TerrainViewer />);
    fireEvent.click(screen.getByRole('button',{name:'Área a monitorear'}));
    const mesh = container.querySelector('mesh[name="aoi-terrain-mesh"]')!;
    act(()=>props(mesh).onClick!(pointEvent(0,0)));
    fireEvent.keyDown(window,{key:'Escape'});
    expect(useAoiStore.getState().vertices).toHaveLength(0);
    expect(useAoiStore.getState().drawing).toBe(false);
  });
});
