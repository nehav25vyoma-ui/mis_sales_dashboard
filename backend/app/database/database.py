from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from urllib.parse import quote_plus

from app.config.settings import (
    DATABASE_URL as CONFIGURED_DATABASE_URL,
    DATABASE_HOST,
    DATABASE_PORT,
    DATABASE_NAME,
    DATABASE_USER,
    DATABASE_PASSWORD,
)


if CONFIGURED_DATABASE_URL:
    DATABASE_URL = CONFIGURED_DATABASE_URL.replace("postgres://", "postgresql://", 1)
else:
    missing = [
        name
        for name, value in (
            ("DATABASE_HOST", DATABASE_HOST),
            ("DATABASE_NAME", DATABASE_NAME),
            ("DATABASE_USER", DATABASE_USER),
            ("DATABASE_PASSWORD", DATABASE_PASSWORD),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            "Database configuration is missing. Set DATABASE_URL or: "
            + ", ".join(missing)
        )
    encoded_password = quote_plus(DATABASE_PASSWORD)
    DATABASE_URL = (
        f"postgresql://{DATABASE_USER}:{encoded_password}"
        f"@{DATABASE_HOST}:{DATABASE_PORT}/{DATABASE_NAME}"
    )

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
Base = declarative_base()

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)
