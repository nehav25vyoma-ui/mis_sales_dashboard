"""Vercel ASGI entry point for the FastAPI application."""

import json
from pathlib import Path
import sys


BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

try:
    from main import app  # noqa: E402,F401
except Exception as exc:  # Vercel otherwise replaces import errors with a generic 500.
    startup_error = {
        "status": "startup_error",
        "error_type": type(exc).__name__,
        "detail": str(exc),
    }

    async def app(scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        body = json.dumps(startup_error).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 500,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": body})
