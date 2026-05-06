"""Radar model API endpoints — list and get radar configurations."""

from fastapi import APIRouter, HTTPException

from app.services.radar_registry import get_radar_config, load_all_radar_configs

router = APIRouter()


@router.get("")
async def list_radars():
    """Return all available radar model configurations."""
    configs = load_all_radar_configs()
    return [cfg.model_dump() for cfg in configs]


@router.get("/{model_id}")
async def get_radar(model_id: str):
    """Return a specific radar model configuration."""
    try:
        cfg = get_radar_config(model_id)
        return cfg.model_dump()
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Radar model '{model_id}' not found")
