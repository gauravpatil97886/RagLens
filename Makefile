.DEFAULT_GOAL := help

# Load .env if it exists so POSTGRES_*, DATABASE_URL etc. are available to targets.
ifneq (,$(wildcard .env))
include .env
export
endif

POSTGRES_USER ?= rag
POSTGRES_DB   ?= rag
POSTGRES_PORT ?= 5433
DB_SERVICE    := db
DB_CONTAINER  := rag-demo-db

COMPOSE := docker compose

.PHONY: help up down nuke install backend frontend dev logs psql reset-db health

help: ## Show this list of targets
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*## .*$$' $(firstword $(MAKEFILE_LIST)) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## Start Postgres (pgvector) in Docker and wait until it is healthy
	@if [ ! -f .env ]; then echo "No .env found. Run: cp .env.example .env  (then add your Gemini key)"; exit 1; fi
	$(COMPOSE) up -d
	@echo "Waiting for $(DB_CONTAINER) to become healthy..."
	@until [ "$$(docker inspect -f '{{.State.Health.Status}}' $(DB_CONTAINER) 2>/dev/null)" = "healthy" ]; do \
		sleep 1; \
		printf '.'; \
	done
	@echo ""
	@echo "Postgres is up on localhost:$(POSTGRES_PORT) (db=$(POSTGRES_DB) user=$(POSTGRES_USER))"

down: ## Stop containers, KEEP data (safe default)
	$(COMPOSE) down

nuke: ## DESTRUCTIVE: stop containers and delete the Postgres volume (all ingested docs + cache gone)
	@echo "This deletes the rag_demo_pgdata volume. All documents, chunks and cache entries will be lost."
	@printf "Type 'yes' to continue: "; \
	read confirm; \
	if [ "$$confirm" = "yes" ]; then $(COMPOSE) down -v; else echo "Aborted."; fi

install: ## Install backend (uv) and frontend (npm) dependencies
	cd backend && uv sync
	cd frontend && npm install

backend: ## Run the backend API with auto-reload (uvicorn, :8000)
	cd backend && uv run uvicorn app.main:app --reload --port 8000

frontend: ## Run the frontend dev server (Vite, :5173, proxies /api -> :8000)
	cd frontend && npm run dev

dev: ## Reminder: backend and frontend each need their own terminal
	@echo "Run these in two separate terminals (both need Postgres up via 'make up' first):"
	@echo "  terminal 1: make backend   # http://localhost:8000"
	@echo "  terminal 2: make frontend  # http://localhost:5173"

logs: ## Tail the Postgres container logs
	$(COMPOSE) logs -f $(DB_SERVICE)

psql: ## Open a psql shell into the running Postgres container
	docker exec -it $(DB_CONTAINER) psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

reset-db: ## Drop and recreate the public schema, then re-apply sql/*.sql (destructive to schema/data, keeps the container)
	@echo "Dropping and recreating schema '$(POSTGRES_DB)'.public ..."
	docker exec -i $(DB_CONTAINER) psql -U $(POSTGRES_USER) -d $(POSTGRES_DB) \
		-c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
	@if ls sql/*.sql >/dev/null 2>&1; then \
		for f in sql/*.sql; do \
			echo "Applying $$f"; \
			docker exec -i $(DB_CONTAINER) psql -U $(POSTGRES_USER) -d $(POSTGRES_DB) < $$f; \
		done; \
	else \
		echo "No sql/*.sql files found to apply yet."; \
	fi

health: ## Curl the backend health endpoint
	curl -s http://localhost:8000/api/health | python3 -m json.tool
