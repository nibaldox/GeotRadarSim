import uuid
from typing import Dict, Any, Optional
from pydantic import BaseModel
from datetime import datetime

class JobStatus(BaseModel):
    job_id: str
    status: str  # "PENDING", "COMPLETED", "FAILED"
    created_at: str
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

# In-memory store for simplicity. In production, use Redis.
_JOBS: Dict[str, JobStatus] = {}

def create_job() -> str:
    job_id = str(uuid.uuid4())
    _JOBS[job_id] = JobStatus(
        job_id=job_id,
        status="PENDING",
        created_at=datetime.utcnow().isoformat()
    )
    return job_id

def update_job(job_id: str, status: str, result: Optional[Dict[str, Any]] = None, error: Optional[str] = None):
    if job_id in _JOBS:
        _JOBS[job_id].status = status
        if result is not None:
            _JOBS[job_id].result = result
        if error is not None:
            _JOBS[job_id].error = error

def get_job(job_id: str) -> Optional[JobStatus]:
    return _JOBS.get(job_id)
