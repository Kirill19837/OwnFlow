from __future__ import annotations

import anthropic as sdk
from app.providers.base import AIProvider
from app.config import get_settings
from typing import List, Optional


class AnthropicProvider(AIProvider):
    def __init__(self, model: str = "claude-3-5-sonnet-20241022"):
        self.model = model
        self._client = sdk.AsyncAnthropic(api_key=get_settings().anthropic_api_key)

    async def complete(
        self,
        messages: List[dict],
        tools: Optional[List[dict]] = None,
        response_format: Optional[dict] = None,
    ) -> str:
        # Anthropic uses a separate system field; split it out if present
        system = ""
        filtered = []
        for m in messages:
            if m["role"] == "system":
                system = m["content"]
            else:
                filtered.append(m)

        kwargs: dict = {
            "model": self.model,
            "max_tokens": 8192,
            "messages": filtered,
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = tools

        resp = await self._client.messages.create(**kwargs)
        return resp.content[0].text if resp.content else ""

    async def stream(self, messages: List[dict], tools: Optional[List[dict]] = None):
        system = ""
        filtered = []
        for m in messages:
            if m["role"] == "system":
                system = m["content"]
            else:
                filtered.append(m)

        kwargs: dict = {
            "model": self.model,
            "max_tokens": 8192,
            "messages": filtered,
        }
        if system:
            kwargs["system"] = system

        async with self._client.messages.stream(**kwargs) as stream:
            async for text in stream.text_stream:
                yield text
