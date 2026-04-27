from __future__ import annotations

from pathlib import Path
from pydantic_settings import BaseSettings
from functools import lru_cache

# Resolve .env relative to this file (backend/app/config.py → backend/.env)
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    supabase_url: str
    supabase_service_role_key: str
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    cors_origins: str = "http://localhost:5173"
    frontend_url: str = "http://localhost:5173"

    # Postmark (optional – used for invite emails to bypass Supabase rate limits)
    postmark_token: str = ""
    postmark_from: str = ""

    # Sentry (optional – error monitoring)
    sentry_dsn: str = ""

    @property
    def postmark_enabled(self) -> bool:
        return bool(self.postmark_token and self.postmark_from)

    @property
    def cors_origins_list(self) -> list[str]:
        origins = [o.strip() for o in self.cors_origins.split(",")]
        # Always allow all common Vite dev ports for local development
        for port in range(5173, 5181):
            candidate = f"http://localhost:{port}"
            if candidate not in origins:
                origins.append(candidate)
        return origins

    class Config:
        env_file = str(_ENV_FILE)


@lru_cache
def get_settings() -> Settings:
    return Settings()
