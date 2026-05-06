# LOS Analysis Specification

## Purpose

Line-of-sight ray-casting engine that computes visibility and shadow zones on terrain from radar positions using each radar model's parameters.

## Requirements

### Requirement: LOS Ray-Casting

The system MUST perform line-of-sight analysis by casting rays from the radar position to terrain mesh vertices within the radar's angular coverage and range limits.

#### Scenario: Unobstructed ray to terrain point

- GIVEN a radar at position P with unobstructed line to terrain vertex T within range
- WHEN LOS analysis runs
- THEN the ray from P to T is classified as visible

#### Scenario: Terrain obstruction creates shadow

- GIVEN terrain ridge F intersects the line between radar P and terrain vertex T
- WHEN LOS analysis runs
- THEN T is classified as shadowed
- AND the obstruction point along the ray is recorded

### Requirement: Shadow Zone Computation

The system SHALL compute contiguous shadow regions on the terrain mesh from the ray classification results.

#### Scenario: Single shadow zone from ridge

- GIVEN a radar placed at the pit rim with a terrain ridge blocking a sector
- WHEN shadow zone computation completes
- THEN contiguous shadowed vertices are grouped into a named shadow zone
- AND the zone is highlighted on the 3D terrain

#### Scenario: Multiple disjoint shadow zones

- GIVEN terrain geometry creates multiple separate blocked regions
- WHEN computation completes
- THEN each disjoint shadow zone is identified and rendered independently

### Requirement: Real-Time Recomputation

The system MUST recompute shadow zones within 5 seconds when the radar position changes.

#### Scenario: Radar position update triggers recomputation

- GIVEN a radar is placed and shadow zones are displayed
- WHEN the radar moves to a new position
- THEN shadow zones recompute and the overlay updates within 5 seconds

### Requirement: Radar Parameter Constraints

The system MUST respect each radar model's range and angular limits during ray-casting.

#### Scenario: Range-limited coverage

- GIVEN a radar with maximum range R
- WHEN LOS analysis runs
- THEN terrain vertices beyond distance R from the radar are excluded from coverage analysis

#### Scenario: Angular sector limits

- GIVEN a radar with horizontal angular coverage θ
- WHEN LOS analysis runs
- THEN rays are only cast within the ±θ/2 sector relative to the radar's facing direction
