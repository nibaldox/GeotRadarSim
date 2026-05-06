"""FastAPI application entry point."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="Radar Monitoring Simulator",
    version="0.1.0",
    description="LOS analysis for geotechnical radar monitoring",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


# Import and mount routers
from app.api.terrain import router as terrain_router  # noqa: E402
from app.api.analysis import router as analysis_router  # noqa: E402
from app.api.radars import router as radars_router  # noqa: E402
from app.api.export import router as export_router  # noqa: E402

app.include_router(terrain_router, prefix="/api/terrain", tags=["terrain"])
app.include_router(analysis_router, prefix="/api/analysis", tags=["analysis"])
app.include_router(radars_router, prefix="/api/radars", tags=["radars"])
app.include_router(export_router, prefix="/api/export", tags=["export"])
