from __future__ import annotations

from pydantic import BaseModel, Field
from typing import Literal, Optional, List
from datetime import datetime


# ── Companies ────────────────────────────────────────────
class Company(BaseModel):
    id: str
    name: str
    slug: str
    owner_id: str
    created_at: datetime
    my_role: Optional[str] = None


# ── Organizations (Teams) ────────────────────────────────
class OrgCreate(BaseModel):
    name: str
    owner_id: str
    company_id: Optional[str] = None
    default_ai_model: str = "gpt-4o"


class Org(BaseModel):
    id: str
    name: str
    slug: str
    owner_id: str
    default_ai_model: str
    created_at: datetime


# ── Projects ──────────────────────────────────────────────
class ProjectCreate(BaseModel):
    name: str
    prompt: str
    owner_id: str
    team_id: Optional[str] = None
    ai_model: Optional[str] = None  # override team default
    auto_plan: bool = True
    sprint_days: int = 3


class Project(BaseModel):
    id: str
    name: str
    prompt: str
    owner_id: str
    team_id: Optional[str]
    status: str
    sprint_days: int = 3
    roadmap: Optional[List] = None
    created_at: datetime


# ── Actors ────────────────────────────────────────────────
class ActorCreate(BaseModel):
    project_id: str
    name: str
    type: Literal["human", "ai"] = "ai"
    role: Optional[str] = None
    model: Optional[str] = None
    capabilities: List[str] = Field(default_factory=list)
    avatar_url: Optional[str] = None
    user_id: Optional[str] = None  # links human actor to a real team member
    characteristics: Optional[str] = None  # stored in capabilities[0] for now
    webhook_url: Optional[str] = None      # external agents: dispatch target URL
    agent_api_key: Optional[str] = None    # sent as X-Api-Key to the external agent
    docker_image: Optional[str] = None     # override server default Docker image
    extra_env: Optional[dict] = None       # additional env vars injected at dispatch (secrets)
    company_agent_id: Optional[str] = None # if set, backend resolves template and copies dispatch fields


class Actor(BaseModel):
    id: str
    project_id: str
    name: str
    type: str
    role: Optional[str] = None
    model: Optional[str]
    capabilities: List[str]
    avatar_url: Optional[str]
    user_id: Optional[str] = None


# ── Sprints / Roadmap ────────────────────────────────────
class SprintTheme(BaseModel):
    sprint_number: int
    theme: str
    goal: str


# ── Tasks ─────────────────────────────────────────────────
class TaskDraft(BaseModel):
    title: str
    description: str
    type: str
    priority: Literal["low", "medium", "high", "critical"]
    estimated_hours: float
    depends_on: List[int] = Field(default_factory=list)
    actor_role: Optional[str] = None  # e.g. "UI/UX Designer" — used for role-based assignment


class Task(BaseModel):
    id: str
    sprint_id: str
    project_id: str
    title: str
    description: str
    type: str
    priority: str
    status: str
    estimated_hours: float
    depends_on: List[str] = Field(default_factory=list)


class TaskAssign(BaseModel):
    actor_id: str


# ── Sprints ───────────────────────────────────────────────
class Sprint(BaseModel):
    id: str
    project_id: str
    sprint_number: int
    start_date: str
    end_date: str
    status: str


# ── Deliverables ──────────────────────────────────────────
class Deliverable(BaseModel):
    id: str
    task_id: str
    actor_id: str
    content: str
    tool_calls_log: Optional[List] = None
    created_at: datetime


# ── Project Memory ────────────────────────────────────────
MEMORY_SOURCE_TYPES = Literal[
    "product", "architecture", "coding-standards", "business-rules",
    "code_file", "pull_request", "commit", "document",
]


class MemoryChunkCreate(BaseModel):
    source_type: MEMORY_SOURCE_TYPES
    source_id: Optional[str] = None
    title: str
    content: str
    summary: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    importance: int = Field(default=5, ge=1, le=10)


class MemoryChunkUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    summary: Optional[str] = None
    tags: Optional[List[str]] = None
    importance: Optional[int] = Field(default=None, ge=1, le=10)


# ── Decisions ─────────────────────────────────────────────
DECISION_STATUS = Literal["active", "superseded", "rejected", "draft"]


class DecisionCreate(BaseModel):
    title: str
    status: DECISION_STATUS = "active"
    context: Optional[str] = None
    decision: str
    reason: Optional[str] = None
    consequences: Optional[str] = None
    related_task_ids: List[str] = Field(default_factory=list)


class DecisionUpdate(BaseModel):
    title: Optional[str] = None
    status: Optional[DECISION_STATUS] = None
    context: Optional[str] = None
    decision: Optional[str] = None
    reason: Optional[str] = None
    consequences: Optional[str] = None
    related_task_ids: Optional[List[str]] = None
    superseded_by: Optional[str] = None


