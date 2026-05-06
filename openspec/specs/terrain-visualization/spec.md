# Terrain Visualization Specification

## Purpose

3D terrain rendering with interactive radar placement, camera controls, and real-time shadow zone overlay.

## Requirements

### Requirement: 3D Terrain Rendering

The system MUST render the DTM as an interactive 3D mesh with elevation-based color coding.

#### Scenario: Load terrain into viewport

- GIVEN a valid DTM has been generated
- WHEN the visualization component loads
- THEN the terrain renders as a triangulated 3D mesh with color gradient by elevation
- AND the user can orbit, pan, and zoom the camera

#### Scenario: Large terrain performance

- GIVEN a DTM with over 500,000 triangles
- WHEN the terrain renders
- THEN the viewport maintains at least 30 FPS during interaction

### Requirement: Radar Placement

The system MUST allow interactive radar placement on the terrain surface via mouse click.

#### Scenario: Place radar on terrain surface

- GIVEN a 3D terrain is rendered and a radar model is selected
- WHEN the user clicks a point on the terrain surface
- THEN a radar marker appears at that location snapped to terrain elevation
- AND LOS analysis triggers automatically

#### Scenario: Relocate existing radar

- GIVEN a radar is already placed on the terrain
- WHEN the user clicks a different terrain point
- THEN the radar marker moves to the new position
- AND shadow zones update within 2 seconds

### Requirement: Shadow Zone Overlay

The system MUST overlay shadow zones on the terrain mesh with a distinct visual style.

#### Scenario: Display shadow zones

- GIVEN LOS analysis has completed
- WHEN shadow zones are computed
- THEN shadow areas render as a semi-transparent colored overlay on the terrain
- AND visible areas render in a contrasting color

#### Scenario: Toggle shadow visibility

- GIVEN shadow zones are displayed
- WHEN the user toggles the overlay off
- THEN the overlay is hidden without removing the computed data
