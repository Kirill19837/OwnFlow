from __future__ import annotations

import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import get_settings
from app.api import projects, tasks, actors, orgs, github, companies

settings = get_settings()

if settings.sentry_dsn:
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        send_default_pii=True,
        traces_sample_rate=0.2,
    )

app = FastAPI(title="OwnFlow API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router, prefix="/projects", tags=["projects"])
app.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
app.include_router(actors.router, prefix="/actors", tags=["actors"])
app.include_router(orgs.router, prefix="/orgs", tags=["orgs"])
app.include_router(companies.router)
app.include_router(github.router, prefix="/github", tags=["github"])


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/sentry-debug")
async def trigger_error():
    1 / 0
