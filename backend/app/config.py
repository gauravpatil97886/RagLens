"""Configuration. Every tunable lives in the repo-root .env so the demo can be
re-tuned (chunk size, thresholds) without touching code."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# app/config.py -> app -> backend -> repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = REPO_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",  # .env also holds POSTGRES_* vars that only docker-compose needs
    )

    # --- Gemini ---
    gemini_api_key: str = ""
    gemini_chat_model: str = "gemini-flash-latest"
    gemini_embed_model: str = "gemini-embedding-001"
    embed_dim: int = 768

    # --- Postgres ---
    database_url: str = "postgresql://rag:rag@localhost:5433/rag"

    # --- RAG tuning ---
    chunk_size: int = 1200
    chunk_overlap: int = 200
    top_k: int = 5
    min_similarity: float = 0.25

    # --- Semantic cache ---
    semantic_cache_enabled: bool = True
    semantic_cache_threshold: float = 0.95
    cache_ttl_hours: int = 168

    # --- Uploads ---
    max_upload_bytes: int = 20 * 1024 * 1024


settings = Settings()
