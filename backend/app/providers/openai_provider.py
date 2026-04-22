from __future__ import annotations

from openai import AsyncOpenAI
from app.providers.base import AIProvider
from app.config import get_settings
from typing import List, Optional


class OpenAIProvider(AIProvider):
    def __init__(self, model: str = "gpt-4o"):
        self.model = model
        self._client = AsyncOpenAI(api_key=get_settings().openai_api_key)

    async def complete(
        self,
        messages: List[dict],
        tools: Optional[List[dict]] = None,
        response_format: Optional[dict] = None,
    ) -> str:
        kwargs: dict = {"model": self.model, "messages": messages}
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        if response_format:
            kwargs["response_format"] = response_format
        resp = await self._client.chat.completions.create(**kwargs)
        return resp.choices[0].message.content or ""

    async def stream(self, messages: List[dict], tools: Optional[List[dict]] = None):
        kwargs: dict = {"model": self.model, "messages": messages, "stream": True}
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        async with await self._client.chat.completions.create(**kwargs) as stream:
            async for chunk in stream:
                delta = chunk.choices[0].delta
                if delta.content:
                    yield delta.content
