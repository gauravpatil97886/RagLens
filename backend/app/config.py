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
    # 'off' sends no thinking_config at all; anything else goes through as
    # types.ThinkingConfig(thinking_level=...). Verified on gemini-flash-latest:
    # thinking_level='low' works, thinking_budget=0 is a 400 — so we never use a budget.
    gemini_thinking_level: str = "low"

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

    # --- Pricing, for the "what would this cost" panel only ---
    # This demo runs on the Google AI Studio FREE tier, so actual spend is always $0.
    # These are Google's published paid-tier list prices in USD per 1,000,000 tokens,
    # read from PRICING_SOURCE on PRICING_AS_OF for gemini-flash-latest (which resolved
    # to Gemini 3.6 Flash on that date) and gemini-embedding-001. They are settings, not
    # constants, precisely because list prices and model aliases both move: point
    # GEMINI_CHAT_MODEL somewhere else and these must be re-checked.
    # Thinking tokens are billed at the OUTPUT rate, which is why there is no third rate.
    price_chat_input_per_1m_usd: float = 1.50
    price_chat_output_per_1m_usd: float = 7.50
    price_embed_input_per_1m_usd: float = 0.15
    pricing_source: str = "https://ai.google.dev/gemini-api/docs/pricing"
    pricing_as_of: str = "2026-08-10"
    # Static on purpose: a demo should not depend on an FX API to render a number.
    usd_inr_rate: float = 95.24
    gemini_tier: str = "free"


settings = Settings()
