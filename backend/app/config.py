from __future__ import annotations

from pydantic_settings import BaseSettings
from functools import lru_cache


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

    @property
    def postmark_enabled(self) -> bool:
        return bool(self.postmark_token and self.postmark_from)

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",")]

    class Config:
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    return Settings()
