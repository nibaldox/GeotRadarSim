# Coverage Export Specification

## Purpose

Export coverage analysis results to PDF reports, PNG images, and CSV data files for documentation and further analysis.

## Requirements

### Requirement: PDF Report Export

The system MUST generate a PDF report containing the 3D terrain visualization, radar placement details, and coverage statistics.

#### Scenario: Generate PDF report

- GIVEN a coverage analysis has been completed
- WHEN the user requests PDF export
- THEN the system generates a PDF containing the 3D view snapshot, radar model name, position coordinates, total coverage percentage, and shadow zone summary

#### Scenario: PDF with multiple radars

- GIVEN multiple radars are placed with completed analysis
- WHEN the user exports to PDF
- THEN the report includes each radar's position and individual coverage data

### Requirement: Image Export

The system SHOULD export the current 3D viewport as a PNG image.

#### Scenario: Export current view as PNG

- GIVEN a 3D visualization is displayed
- WHEN the user requests image export
- THEN the system captures the current viewport at display resolution as a downloadable PNG

### Requirement: CSV Data Export

The system SHOULD export terrain point coverage data as a CSV file.

#### Scenario: Export coverage CSV

- GIVEN a coverage analysis has been completed
- WHEN the user requests data export
- THEN the system generates a CSV with columns: x, y, z, visible, distance_from_radar, shadow_zone_id

#### Scenario: CSV with no analysis data

- GIVEN no coverage analysis has been run
- WHEN the user attempts data export
- THEN the system disables the export action with a message indicating analysis is required
