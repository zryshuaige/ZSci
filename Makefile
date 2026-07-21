.PHONY: install backend frontend dev dev-backend dev-frontend test migrate lint clean

PYTHON ?= python3.12
BACKEND_DIR := backend
FRONTEND_DIR := frontend
UV ?= $(shell command -v uv || echo $(HOME)/.local/bin/uv)

install: install-backend install-frontend

install-backend:
	cd $(BACKEND_DIR) && $(UV) sync

install-frontend:
	cd $(FRONTEND_DIR) && npm install

migrate:
	cd $(BACKEND_DIR) && $(UV) run alembic upgrade head

dev:
	@echo "Starting backend (http://127.0.0.1:8000) and frontend (http://localhost:5173) in parallel…"
	@echo "Ctrl+C stops both."
	@trap 'kill 0' INT TERM EXIT; \
	( cd $(BACKEND_DIR) && $(UV) run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 ) & \
	( cd $(FRONTEND_DIR) && npm run dev ) & \
	wait

dev-backend:
	cd $(BACKEND_DIR) && $(UV) run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

dev-frontend:
	cd $(FRONTEND_DIR) && npm run dev

backend:
	cd $(BACKEND_DIR) && $(UV) run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

frontend:
	cd $(FRONTEND_DIR) && npm run dev

test:
	cd $(BACKEND_DIR) && $(UV) run pytest -q

lint:
	cd $(BACKEND_DIR) && $(UV) run ruff check . || true
	cd $(FRONTEND_DIR) && npm run lint || true

clean:
	rm -rf $(BACKEND_DIR)/.venv $(FRONTEND_DIR)/node_modules $(FRONTEND_DIR)/dist
