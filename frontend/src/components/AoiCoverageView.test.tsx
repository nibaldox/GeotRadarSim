import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { AoiCoverageView } from './AoiCoverageView';
import { useAoiStore } from '../store/aoiStore';
import { useTerrainStore } from '../store/terrainStore';
import { useAnalysisStore } from '../store/analysisStore';
import { useVectorStore } from '../store/vectorStore';
import { computeAoiCoverage, aoiMaskForGrid } from '../utils/aoi';
import { useQualityPolicyStore } from '../store/qualityPolicyStore';
import type { LOSResponse } from '../types/api';

function fixture() {
  const key = {terrain_id:'t', epoch: 1};
  const grid = [[0,0],[0,0]];
  const bounds = {min_x:0,min_y:0,min_z:0,max_x:1,max_y:1,max_z:0};
  const metadata = {terrain_id:'t',bounds,resolution:1,grid_rows:2,grid_cols:2};
  const result = {grid_rows:2,grid_cols:2,resolution:1,quality_model:'geometric-v2',cell_states: Uint8Array.from([5,5,4,5]),flat_quality_grid:Float32Array.from([0.8,0.4,0,0.1]),flat_projection_grid:Float32Array.from([0.8,0.8,0,0.8])} as LOSResponse;
  useTerrainStore.setState({terrainKey:key,grid,metadata,loading:false});
  const a = useAoiStore.getState(); a.clear(); a.startDrawing();
  a.addVertex({x:0,y:0}); a.addVertex({x:1,y:0}); a.addVertex({x:1,y:1}); a.addVertex({x:0,y:1}); a.closePolygon();
  const snapshot = {terrainKey:key,analysisId:'one',sourceAnalysisIds:['one'],generation:1,radars:[]};
  useAnalysisStore.setState({terrainKey:key,activeSnapshot:snapshot,losResult:result,loading:false,multiLoading:false,terrainTransitioning:false});
  useVectorStore.setState({visualizationMode:'QUALITY'});
  const mask = aoiMaskForGrid({grid,bounds,resolution:1},useAoiStore.getState().polygon!);
  const coverage = (metric: 'INCIDENCE' | 'PROJECTION') => computeAoiCoverage(result,mask,useQualityPolicyStore.getState().policy,{metric,terrainGrid:grid,terrainResolution:metadata.resolution,terrainKey:key,snapshot});
  return {key,snapshot,coverage};
}

describe('Cobertura del área', () => {
  it('muestra la métrica real de WP14 y respeta la selección incidencia/proyección', () => {
    const {coverage} = fixture();
    const incidence = coverage('INCIDENCE');
    const projection = coverage('PROJECTION');
    expect(incidence?.usefulPct).toBeGreaterThan(0);
    expect(projection?.usefulPct).not.toBe(incidence?.usefulPct);
    render(<AoiCoverageView current />);
    expect(screen.getByText(`Área útil: ${incidence!.usefulPct!.toFixed(1)}%`)).toBeInTheDocument();
    act(() => useVectorStore.setState({visualizationMode:'SENSITIVITY'}));
    expect(screen.getByText(`Área útil: ${projection!.usefulPct!.toFixed(1)}%`)).toBeInTheDocument();
  });

  it('oculta cifras ante snapshot obsoleto del mismo terreno o datos incoherentes', () => {
    const {key,snapshot} = fixture();
    render(<AoiCoverageView current />);
    expect(screen.getByText(/Área útil: \d/)).toBeInTheDocument();
    act(() => useAnalysisStore.setState({activeSnapshot:{...snapshot,terrainKey:{...key,epoch:0}}}));
    expect(screen.queryByText(/Área útil: \d/)).not.toBeInTheDocument();
    expect(screen.getByText('Ejecuta un análisis vigente para consultar el área.')).toBeInTheDocument();
    act(() => {
      useAnalysisStore.setState({activeSnapshot:snapshot});
      useTerrainStore.setState({grid:[[Number.NaN,0],[0,0]]});
    });
    expect(screen.queryByText(/Área útil: \d/)).not.toBeInTheDocument();
    expect(screen.getByText('Ejecuta un análisis vigente para consultar el área.')).toBeInTheDocument();
  });
});
