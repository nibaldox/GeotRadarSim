import { useEffect, useMemo, useRef } from 'react';
import { Line } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useAoiStore } from '../store/aoiStore';
import { useTerrainStore } from '../store/terrainStore';
import { buildTerrainMeshGeometry } from './TerrainViewer';
import { getMinElevation } from '../utils/terrain';

export function AoiOverlay({active}: {active: boolean}) {
  const {vertices, polygon, drawing, moveVertex, closePolygon} = useAoiStore();
  const {grid, metadata, terrainKey} = useTerrainStore();
  const {gl, camera, scene} = useThree();
  const drag = useRef<number | null>(null);
  const geometry = useMemo(() => grid && metadata ? buildTerrainMeshGeometry(grid,metadata.resolution,getMinElevation(grid)) : null,[grid,metadata]);
  useEffect(() => () => geometry?.dispose(),[geometry]);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (drag.current === null || !metadata) return;
      const rect = gl.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1, -(e.clientY-rect.top)/rect.height*2+1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(pointer,camera);
      const mesh = scene.getObjectByName('aoi-terrain-mesh');
      const hit = mesh && ray.intersectObject(mesh)[0];
      if (hit) moveVertex(drag.current,{x:hit.point.x+metadata.bounds.min_x,y:metadata.bounds.min_y-hit.point.z});
    };
    const up = () => { drag.current = null; };
    gl.domElement.addEventListener('pointermove',move); window.addEventListener('pointerup',up);
    return () => { gl.domElement.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up); };
  },[gl,camera,scene,metadata,moveVertex]);
  if (!grid || !metadata || !terrainKey || !geometry || vertices.length === 0) return null;
  const {bounds,resolution} = metadata; const min = getMinElevation(grid);
  const radius = Math.max((bounds.max_x-bounds.min_x),(bounds.max_y-bounds.min_y))*0.007;
  const point = (x:number,y:number): [number,number,number] => {
    const c = Math.max(0,Math.min((grid[0]?.length ?? 1)-1,(x-bounds.min_x)/resolution));
    const r = Math.max(0,Math.min(grid.length-1,(y-bounds.min_y)/resolution));
    const ci = Math.min(Math.floor(c),(grid[0]?.length ?? 2)-2); const ri = Math.min(Math.floor(r),grid.length-2);
    const dx=c-ci, dy=r-ri; const a=grid[ri]?.[ci] ?? 0, b=grid[ri]?.[ci+1] ?? a, d=grid[ri+1]?.[ci] ?? a, e=grid[ri+1]?.[ci+1] ?? a;
    const h=dx+dy<=1 ? a+(b-a)*dx+(d-a)*dy : e+(d-e)*(1-dx)+(b-e)*(1-dy);
    return [x-bounds.min_x,(Number.isFinite(h)?h:min)-min+resolution*0.12,bounds.min_y-y];
  };
  const points = vertices.map(v=>point(v.x,v.y));
  const uniforms = { count:{value:vertices.length}, poly:{value:Array.from({length:64},(_,i)=>new THREE.Vector2((vertices[i]?.x ?? bounds.min_x)-bounds.min_x, (vertices[i]?.y ?? bounds.min_y)-bounds.min_y))} };
  return <group>
    {polygon && <mesh geometry={geometry} raycast={() => null} renderOrder={2}>
      <shaderMaterial transparent depthWrite={false} side={THREE.DoubleSide} uniforms={uniforms}
        vertexShader={'varying vec2 p; void main(){p=vec2(position.x, -position.z); vec3 q=position; q.y+=0.1; gl_Position=projectionMatrix*modelViewMatrix*vec4(q,1.0);}'}
        fragmentShader={'varying vec2 p; uniform vec2 poly[64]; uniform int count; void main(){bool inside=false; for(int i=0;i<64;i++){if(i>=count) break; int j=i==0?count-1:i-1; vec2 a=poly[i],b=poly[j]; if((a.y>p.y)!=(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) inside=!inside;} if(!inside) discard; gl_FragColor=vec4(0.0,0.85,1.0,0.32);}'} />
    </mesh>}
    {points.length > 1 && <Line points={polygon ? [...points,points[0]!] : points} color="#00eaff" lineWidth={3} />}
    {active && points.map((p,i)=><mesh key={i} position={p} onPointerDown={e=>{e.stopPropagation(); if (drawing && i===0) closePolygon(); else if (polygon) drag.current=i;}}><sphereGeometry args={[Math.max(radius,0.5),12,12]}/><meshBasicMaterial color="#00f4ff" /></mesh>)}
  </group>;
}
