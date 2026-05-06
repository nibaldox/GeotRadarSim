# Radar Models Specification

## Purpose

Data-driven radar parameter management for the three supported slope monitoring radar models.

## Requirements

### Requirement: Radar Model Registry

The system MUST define each radar model as a data configuration with parameters: maximum range, horizontal angular coverage, vertical angular coverage, and beam resolution.

#### Scenario: List available models

- GIVEN the application is initialized
- WHEN the radar model selector renders
- THEN the user sees GroundProbe SSR-FX, IBIS-ArcSAR360, and Reutech MSR as selectable options

#### Scenario: Select a radar model

- GIVEN the model selector is displayed
- WHEN the user selects a radar model
- THEN the system loads that model's parameters and triggers coverage recomputation

### Requirement: GroundProbe SSR-FX Parameters

The system SHALL include GroundProbe SSR-FX with its operational range, angular coverage, and resolution parameters.

#### Scenario: GroundProbe coverage computation

- GIVEN GroundProbe SSR-FX is the selected model
- WHEN coverage analysis runs
- THEN the system applies the SSR-FX range and sector parameters to ray-casting

### Requirement: IBIS-ArcSAR360 Parameters

The system SHALL include IBIS-ArcSAR360 with its 360° scanning parameters.

#### Scenario: IBIS 360° coverage computation

- GIVEN IBIS-ArcSAR360 is the selected model
- WHEN coverage analysis runs
- THEN the system applies full 360° horizontal coverage parameters to ray-casting

### Requirement: Reutech MSR Parameters

The system SHALL include Reutech MSR with its operational parameters.

#### Scenario: Reutech coverage computation

- GIVEN Reutech MSR is the selected model
- WHEN coverage analysis runs
- THEN the system applies the MSR range and sector parameters to ray-casting

### Requirement: Model Parameter Extensibility

The system SHOULD allow adding new radar models via configuration without code changes.

#### Scenario: Add a new model via config

- GIVEN a JSON config file with a new radar model's parameters
- WHEN the application reloads
- THEN the new model appears in the selector with correct parameters
