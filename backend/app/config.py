"""Central configuration. Everything comes from environment variables (repo-root .env).

No credential is ever hardcoded here -- see .env.example for where each value comes from.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

# Load the repo-root .env regardless of where uvicorn is started from.
_REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_REPO_ROOT / ".env")

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DB = os.getenv("MONGODB_DB", "museic")

AUTH0_DOMAIN = os.getenv("AUTH0_DOMAIN", "")
AUTH0_AUDIENCE = os.getenv("AUTH0_AUDIENCE", "")
AUTH0_TOKEN_VAULT_CLIENT_ID = os.getenv("AUTH0_TOKEN_VAULT_CLIENT_ID", "")
AUTH0_TOKEN_VAULT_CLIENT_SECRET = os.getenv("AUTH0_TOKEN_VAULT_CLIENT_SECRET", "")
AUTH0_SPOTIFY_CONNECTION = os.getenv("AUTH0_SPOTIFY_CONNECTION", "spotify")

BACKBOARD_API_KEY = os.getenv("BACKBOARD_API_KEY", "")
BACKBOARD_ASSISTANT_ID = os.getenv("BACKBOARD_ASSISTANT_ID", "")
BACKBOARD_GEMINI_MODEL = os.getenv("BACKBOARD_GEMINI_MODEL", "gemini-2.0-flash")
BACKBOARD_BASE_URL = "https://app.backboard.io/api"

AUDIO_DIR = Path(os.getenv("AUDIO_DIR", str(_REPO_ROOT / "library"))).resolve()
