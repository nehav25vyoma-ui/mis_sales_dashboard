"""Vercel ASGI entry point for the FastAPI application."""

from pathlib import Path
import sys

from fastapi import FastAPI


BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

app = FastAPI()

try:
    from main import app as backend_app  # noqa: E402
except Exception as exc:  # Vercel otherwise replaces import errors with a generic 500.
    startup_error = {
        "status": "startup_error",
        "error_type": type(exc).__name__,
        "detail": str(exc),
    }

    @app.get("/{path:path}", status_code=500)
    def report_startup_error(path: str):
        return startup_error
else:
    app = backend_app
