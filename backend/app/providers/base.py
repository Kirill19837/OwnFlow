from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List, Optional


class AIProvider(ABC):
    @abstractmethod
    async def complete(
        self,
        messages: List[dict],
        tools: Optional[List[dict]] = None,
        response_format: Optional[dict] = None,
    ) -> str:
        """Return the assistant text content of the response."""
        ...

    @abstractmethod
    async def stream(
        self,
        messages: List[dict],
        tools: Optional[List[dict]] = None,
    ):
        """Async generator yielding text chunks."""
        ...
