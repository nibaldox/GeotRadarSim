"""Radar model registry — loads YAML configs for radar models at startup."""

from pathlib import Path

import yaml

from app.models.domain import RadarConfig

_RADARS_DIR = Path(__file__).parent.parent / "config" / "radars"

_registry: dict[str, RadarConfig] = {}


def _load_yaml_configs() -> dict[str, RadarConfig]:
    """Discover and load all YAML radar configs from the radars directory."""
    configs: dict[str, RadarConfig] = {}
    if not _RADARS_DIR.exists():
        return configs
    for yaml_file in sorted(_RADARS_DIR.glob("*.yaml")):
        with open(yaml_file) as f:
            data = yaml.safe_load(f)
        cfg = RadarConfig(**data)
        configs[cfg.model_id] = cfg
    return configs


def load_all_radar_configs() -> list[RadarConfig]:
    """Return all loaded radar configurations."""
    if not _registry:
        _registry.update(_load_yaml_configs())
    return list(_registry.values())


def get_radar_config(model_id: str) -> RadarConfig:
    """Return a specific radar configuration by model ID.

    Raises KeyError if not found.
    """
    if not _registry:
        _registry.update(_load_yaml_configs())
    if model_id not in _registry:
        raise KeyError(f"Radar model '{model_id}' not found in registry")
    return _registry[model_id]


def clear_registry() -> None:
    """Clear the cached registry. Useful for testing."""
    _registry.clear()
