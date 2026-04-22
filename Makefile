.PHONY: check check-backend check-frontend

# Run all pre-commit checks (backend + frontend)
check: check-backend check-frontend
	@echo ""
	@echo "✓ All checks passed — safe to commit."

check-backend:
	@echo "── Backend: lint ────────────────────────────────"
	cd backend && source .venv/bin/activate && ruff check app/
	@echo "── Backend: tests ───────────────────────────────"
	cd backend && source .venv/bin/activate && python -m pytest tests/ -v

check-frontend:
	@echo "── Frontend: lint ───────────────────────────────"
	cd frontend && npm run lint
	@echo "── Frontend: type-check & build ─────────────────"
	cd frontend && npm run build
