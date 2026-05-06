"""In-memory terrain store — holds generated DTMs keyed by terrain_id."""

from typing import Optional

import numpy as np

from app.services.dtm_generator import DTMResult

_store: dict[str, DTMResult] = {}


def store_terrain(result: DTMResult) -> str:
    """Store a DTM result and return its terrain_id."""
    _store[result.metadata.terrain_id] = result
    return result.metadata.terrain_id


def get_terrain(terrain_id: str) -> Optional[DTMResult]:
    """Retrieve a stored DTM result by terrain_id. Returns None if not found."""
    return _store.get(terrain_id)


def clear_store() -> None:
    """Clear all stored terrains."""
    _store.clear()
