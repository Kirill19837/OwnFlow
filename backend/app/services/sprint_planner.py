from __future__ import annotations

from datetime import date, timedelta
from typing import List, Optional, Dict
from app.models import TaskDraft
from app.db import get_supabase
import uuid

SPRINT_DAYS = 3
HOURS_PER_DAY = 8
CAPACITY_PER_SPRINT = SPRINT_DAYS * HOURS_PER_DAY  # 24 h


def _topo_sort(tasks: List[TaskDraft]) -> List[int]:
    """Return task indices in dependency-safe order."""
    n = len(tasks)
    visited: set = set()
    order: List[int] = []

    def visit(i: int):
        if i in visited:
            return
        visited.add(i)
        for dep in tasks[i].depends_on:
            visit(dep)
        order.append(i)

    for i in range(n):
        visit(i)
    return order


async def plan_and_persist(
    project_id: str,
    tasks: List[TaskDraft],
    start_date: Optional[date] = None,
) -> dict:
    """Pack tasks into 3-day sprints and write sprints + tasks to Supabase."""
    if start_date is None:
        start_date = date.today()

    db = get_supabase()
    sorted_indices = _topo_sort(tasks)

    # Pack tasks into sprints based on estimated capacity
    sprints: List[dict] = []
    task_rows: List[dict] = []
    # map original index → db task id
    idx_to_id: Dict[int, str] = {}

    current_sprint_tasks: List[int] = []
    current_hours = 0.0
    sprint_num = 0

    def flush_sprint(task_indices: List[int], snum: int):
        sprint_start = start_date + timedelta(days=snum * SPRINT_DAYS)
        sprint_end = sprint_start + timedelta(days=SPRINT_DAYS - 1)
        sprint_id = str(uuid.uuid4())
        sprints.append(
            {
                "id": sprint_id,
                "project_id": project_id,
                "sprint_number": snum + 1,
                "start_date": sprint_start.isoformat(),
                "end_date": sprint_end.isoformat(),
                "status": "planned",
            }
        )
        for idx in task_indices:
            t = tasks[idx]
            task_id = str(uuid.uuid4())
            idx_to_id[idx] = task_id
            task_rows.append(
                {
                    "id": task_id,
                    "sprint_id": sprint_id,
                    "project_id": project_id,
                    "title": t.title,
                    "description": t.description,
                    "type": t.type,
                    "priority": t.priority,
                    "estimated_hours": t.estimated_hours,
                    "status": "todo",
                    "depends_on": [],  # resolved after all IDs known
                }
            )
        return sprint_id

    sprint_task_buckets: List[List[int]] = []

    for idx in sorted_indices:
        h = tasks[idx].estimated_hours
        if current_hours + h > CAPACITY_PER_SPRINT and current_sprint_tasks:
            sprint_task_buckets.append(current_sprint_tasks)
            current_sprint_tasks = []
            current_hours = 0.0
        current_sprint_tasks.append(idx)
        current_hours += h

    if current_sprint_tasks:
        sprint_task_buckets.append(current_sprint_tasks)

    sprint_ids: List[str] = []
    for snum, bucket in enumerate(sprint_task_buckets):
        sid = flush_sprint(bucket, snum)
        sprint_ids.append(sid)

    # Resolve depends_on indices → UUIDs
    for row in task_rows:
        # find original index for this task
        task_idx = next(i for i, v in idx_to_id.items() if v == row["id"])
        row["depends_on"] = [
            idx_to_id[dep] for dep in tasks[task_idx].depends_on if dep in idx_to_id
        ]

    # Persist to Supabase
    db.table("sprints").insert(sprints).execute()
    db.table("tasks").insert(task_rows).execute()

    return {"sprint_ids": sprint_ids, "task_count": len(task_rows)}
