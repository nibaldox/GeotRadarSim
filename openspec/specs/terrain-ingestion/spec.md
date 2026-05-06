# Terrain Ingestion Specification

## Purpose

Handles DXF file parsing, DTM mesh generation, and synthetic terrain creation for the radar monitoring simulator.

## Requirements

### Requirement: DXF File Parsing

The system MUST parse DXF files containing 3D polylines and point entities, extracting vertex coordinates into a point cloud for terrain mesh generation.

#### Scenario: Valid DXF with 3D polylines

- GIVEN a DXF file containing 3D POLYLINE entities with elevation data
- WHEN the user uploads the file
- THEN the system extracts all vertex coordinates into a structured point cloud
- AND reports the bounding box dimensions and total point count

#### Scenario: DXF with no elevation data

- GIVEN a DXF file containing only 2D entities without Z values
- WHEN the user uploads the file
- THEN the system returns a validation error indicating missing elevation data

#### Scenario: Malformed DXF file

- GIVEN a corrupted or invalid DXF file
- WHEN the user attempts to upload
- THEN the system rejects the file with a descriptive parse error

### Requirement: DTM Mesh Generation

The system SHALL generate a triangulated Digital Terrain Model from the extracted point cloud using Delaunay triangulation.

#### Scenario: Dense point cloud input

- GIVEN a point cloud with sufficient density (>1000 points)
- WHEN DTM generation is triggered
- THEN the system produces a triangulated mesh within 3 seconds
- AND elevation accuracy is preserved within ±0.5m of source data

#### Scenario: Sparse point cloud input

- GIVEN a point cloud with fewer than 100 points
- WHEN DTM generation is triggered
- THEN the system warns about insufficient density and produces an interpolated mesh

### Requirement: Synthetic Terrain Generation

The system SHOULD provide procedural terrain generation for testing without real DXF data.

#### Scenario: Generate test pit terrain

- GIVEN the user requests synthetic terrain with approximate dimensions
- WHEN the generation runs
- THEN the system produces a bowl-shaped open pit terrain with configurable size, depth, and resolution
