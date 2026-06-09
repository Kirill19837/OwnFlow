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


def check_and_increment_by_company(company_id: str) -> None:
    """
    Atomically check the AI prompt limit and increment the counter by 1.
    Raises PermissionError if the limit is already reached.
    """
    db = get_supabase()

    result = db.rpc("increment_ai_prompts", {"p_company_id": company_id}).execute()

    # If the UPDATE found no matching row, the limit was already reached
    if not result.data:
        # Fetch current values only to build a meaningful error message
        company = (
            db.table("companies")
            .select("ai_prompts_used, ai_prompts_limit")
            .eq("id", company_id)
            .single()
            .execute()
        )
        data = company.data or {}
        used = data.get("ai_prompts_used", 0)
        limit = data.get("ai_prompts_limit", 100)
        raise PermissionError(
            f"AI prompt limit reached ({used}/{limit}). Please upgrade your plan."
        )


def check_and_increment(project_id: str) -> None:
    """Same as check_and_increment_by_company but resolves company_id from project_id first."""
    company_id = get_company_id_for_project(project_id)
    if not company_id:
        return  # No company found — allow without blocking
    check_and_increment_by_company(company_id)
