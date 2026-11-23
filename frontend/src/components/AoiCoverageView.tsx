import { useAoiCoverage } from '../hooks/useGlobalQuality';

export function AoiCoverageView({current}: {current: boolean}) {
  // Same conditions and computation as before, now in the shared hook (mask memoised).
  const {hasPolygon, coverage} = useAoiCoverage(current);
  const pct = (n: number | null) => n === null ? 'Sin datos' : `${n.toFixed(1)}%`;
  return <div className="aoi-coverage" aria-label="Cobertura del área">
    <strong>Cobertura del área</strong>
    {!hasPolygon ? <div>Dibuja un área para consultar su cobertura.</div> : !coverage ? <div>Ejecuta un análisis vigente para consultar el área.</div> : <>
      <div>Área útil: {pct(coverage.usefulPct)}</div><div>Área visible: {pct(coverage.visiblePct)}</div><div>Celdas del área: {coverage.aoiCellCount}</div>
    </>}
  </div>;
}
