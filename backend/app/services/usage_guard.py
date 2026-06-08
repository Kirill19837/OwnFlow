from app.db import get_supabase


def get_company_id_for_project(project_id: str) -> str | None:
    """Resolve company_id for a project via project → team → company."""
    db = get_supabase()
    project = db.table("projects").select("team_id").eq("id", project_id).single().execute()
    team_id = (project.data or {}).get("team_id")
    if not team_id:
        return None
    team = db.table("teams").select("company_id").eq("id", team_id).single().execute()
    return (team.data or {}).get("company_id")


def check_and_increment(project_id: str) -> None:
    """
    Check the AI prompt limit for the company that owns this project.
    Raises PermissionError if the limit is reached.
    Increments the counter by 1 if within limit.
    """
    db = get_supabase()
    company_id = get_company_id_for_project(project_id)
    if not company_id:
        return  # no company found — allow without blocking

    company = (
        db.table("companies")
        .select("ai_prompts_used, ai_prompts_limit")
        .eq("id", company_id)
        .single()
        .execute()
    )

    data = company.data or {}
    used = data.get("ai_prompts_used") or 0
    limit = data.get("ai_prompts_limit") or 100

    if used >= limit:
        raise PermissionError(
            f"AI prompt limit reached ({used}/{limit}). Please upgrade your plan."
        )

    db.table("companies").update({"ai_prompts_used": used + 1}).eq("id", company_id).execute()

def check_and_increment_by_company(company_id: str) -> None:
    """Same as check_and_increment but takes company_id directly."""
    db = get_supabase()
    company = (
        db.table("companies")
        .select("ai_prompts_used, ai_prompts_limit")
        .eq("id", company_id)
        .single()
        .execute()
    )
    data = company.data or {}
    used = data.get("ai_prompts_used") or 0
    limit = data.get("ai_prompts_limit") or 100

    if used >= limit:
        raise PermissionError(
            f"AI prompt limit reached ({used}/{limit}). Please upgrade your plan."
        )

    db.table("companies").update({"ai_prompts_used": used + 1}).eq("id", company_id).execute()
