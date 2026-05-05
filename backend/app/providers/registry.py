from __future__ import annotations

from typing import Optional
from app.providers.base import AIProvider

_OPENAI_MODELS = {"gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1-mini", "o3-mini"}
_ANTHROPIC_MODELS = {
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
}


def get_provider(model: str, api_key: Optional[str] = None) -> AIProvider:
    if model in _ANTHROPIC_MODELS or model.startswith("claude"):
        from app.providers.anthropic_provider import AnthropicProvider
        return AnthropicProvider(model=model, api_key=api_key)
    # default → OpenAI
    from app.providers.openai_provider import OpenAIProvider
    return OpenAIProvider(model=model, api_key=api_key)
