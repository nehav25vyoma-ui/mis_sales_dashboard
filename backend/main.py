from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from sqlalchemy import text

from app.database.database import engine
from app.database import models  # noqa: F401
from app.uploads.dsg import router as upload_router
from app.uploads.sfh import router as sfh_upload_router
from app.dashboard import router as dashboard_router
from app.uploads.direct_sales import router as direct_sales_router
from app.uploads.amazon import router as amazon_upload_router
from app.reports import router as reports_router
from app.plans import router as plans_router

app = FastAPI(title="MIS Sales API", version="0.1.0")
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.include_router(upload_router)
app.include_router(sfh_upload_router)
app.include_router(dashboard_router)
app.include_router(direct_sales_router)
app.include_router(amazon_upload_router)
app.include_router(reports_router)
app.include_router(plans_router)


@app.get("/")
def home():
    return {"message": "MIS Sales Backend is Running"}


@app.get("/db-test")
@app.get("/api/db-test")
def db_test():
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    return {"message": "Database Connected Successfully"}


@app.get("/api/health")
def health():
    return {"status": "ok"}
