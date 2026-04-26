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
    type: Literal["human", "ai"]
    role: Optional[str] = None
    model: Optional[str] = None
    capabilities: List[str] = Field(default_factory=list)
    avatar_url: Optional[str] = None


class Actor(BaseModel):
    id: str
    project_id: str
    name: str
    type: str
    role: Optional[str] = None
    model: Optional[str]
    capabilities: List[str]
    avatar_url: Optional[str]


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
