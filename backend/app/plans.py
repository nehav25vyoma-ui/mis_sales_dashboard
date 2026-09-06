from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func

from app.database.database import SessionLocal, engine
from app.database.models import CategoryPlan, ChannelPlan


router = APIRouter(prefix="/api/plans", tags=["plans"])

PLAN_CHANNELS = ("Digital Online", "In Office", "Stall", "Bulk", "Call", "Retail", "Course Promotion", "Language Lab", "OTT")
DEFAULT_2026_PLANS = {
    "Digital Online": 300_000,
    "In Office": 50_000,
    "Stall": 50_000,
    "Bulk": 25_000,
    "Call": 25_000,
    "Retail": 25_000,
    "Course Promotion": 25_000,
    "Language Lab": 125_000,
    "OTT": 200_000,
}
LEGACY_DIGITAL_CHANNELS = ("DSG", "SFH", "Amazon")
LEGACY_DIRECT_CHANNELS = {
    "In Office": "Direct Sales",
    "Stall": "Stall Sales",
    "Bulk": "Bulk Sales",
}
CATEGORY_PLAN_NAMES = ("Books", "Web Version", "Audio Device", "Pen Drive")
DEFAULT_2026_CATEGORY_PLANS = {
    "Books": 200_000,
    "Web Version": 150_000,
    "Audio Device": 100_000,
    "Pen Drive": 50_000,
}


class PlanWrite(BaseModel):
    year: int = Field(ge=2026, le=9999)
    channel: str
    monthly_plan: int = Field(ge=0)


class CategoryPlanWrite(BaseModel):
    year: int = Field(ge=2026, le=9999)
    category: str
    monthly_plan: int = Field(ge=0)


def ensure_plan_table() -> None:
    ChannelPlan.__table__.create(bind=engine, checkfirst=True)
    CategoryPlan.__table__.create(bind=engine, checkfirst=True)


def plans_for_year(year: int) -> dict[str, int]:
    """Return saved plans overlaid on the untouched 2026 defaults."""
    ensure_plan_table()
    defaults = dict(DEFAULT_2026_PLANS) if year == 2026 else {channel: 0 for channel in PLAN_CHANNELS}
    if year == 2026:
        return defaults
    with SessionLocal() as database:
        records = database.query(ChannelPlan).filter(ChannelPlan.year == year).all()
        saved = {record.channel: int(record.monthly_plan) for record in records}
        defaults.update({channel: value for channel, value in saved.items() if channel in PLAN_CHANNELS})
        for channel, legacy_channel in LEGACY_DIRECT_CHANNELS.items():
            if channel not in saved and legacy_channel in saved:
                defaults[channel] = saved[legacy_channel]
        if "Digital Online" not in saved and any(channel in saved for channel in LEGACY_DIGITAL_CHANNELS):
            defaults["Digital Online"] = sum(saved.get(channel, 0) for channel in LEGACY_DIGITAL_CHANNELS)
    return defaults


def category_plans_for_year(year: int) -> dict[str, int]:
    ensure_plan_table()
    defaults = dict(DEFAULT_2026_CATEGORY_PLANS) if year == 2026 else {category: 0 for category in CATEGORY_PLAN_NAMES}
    if year == 2026:
        return defaults
    with SessionLocal() as database:
        for record in database.query(CategoryPlan).filter(CategoryPlan.year == year).all():
            defaults[record.category] = int(record.monthly_plan)
    return defaults


def plan_data(record: ChannelPlan) -> dict[str, object]:
    monthly = int(record.monthly_plan)
    return {
        "year": record.year,
        "channel": record.channel,
        "monthly_plan": monthly,
        "quarterly_plan": monthly * 3,
        "yearly_plan": monthly * 12,
        "saved": True,
    }


@router.get("")
def list_plans(year: int) -> dict[str, object]:
    if year < 2026 or year > 9999:
        raise HTTPException(status_code=422, detail="Year must be 2026 or later.")
    ensure_plan_table()
    with SessionLocal() as database:
        saved = {
            record.channel: record
            for record in database.query(ChannelPlan).filter(ChannelPlan.year == year).all()
        }
        if year == 2026:
            saved = {}
        plans = []
        resolved = dict(DEFAULT_2026_PLANS) if year == 2026 else {channel: 0 for channel in PLAN_CHANNELS}
        resolved.update({channel: int(record.monthly_plan) for channel, record in saved.items() if channel in PLAN_CHANNELS})
        for channel, legacy_channel in LEGACY_DIRECT_CHANNELS.items():
            if channel not in saved and legacy_channel in saved:
                resolved[channel] = int(saved[legacy_channel].monthly_plan)
        legacy_digital = sum(int(saved[channel].monthly_plan) for channel in LEGACY_DIGITAL_CHANNELS if channel in saved)
        if "Digital Online" not in saved and legacy_digital:
            resolved["Digital Online"] = legacy_digital
        for channel in PLAN_CHANNELS:
            monthly = resolved[channel]
            plans.append({
                "year": year,
                "channel": channel,
                "monthly_plan": monthly,
                "quarterly_plan": monthly * 3,
                "yearly_plan": monthly * 12,
                "saved": channel in saved,
                "derived_from_legacy": channel == "Digital Online" and channel not in saved and bool(legacy_digital),
                "protected_default": year == 2026 and channel not in saved,
            })
    return {"year": year, "channels": list(PLAN_CHANNELS), "plans": plans}


@router.put("")
def save_plan(payload: PlanWrite) -> dict[str, object]:
    if payload.channel not in PLAN_CHANNELS:
        raise HTTPException(status_code=422, detail="Unsupported plan channel.")
    if payload.year == 2026:
        raise HTTPException(status_code=409, detail="The existing 2026 plan is protected and cannot be changed.")
    ensure_plan_table()
    with SessionLocal() as database:
        record = database.query(ChannelPlan).filter(
            ChannelPlan.year == payload.year,
            ChannelPlan.channel == payload.channel,
        ).one_or_none()
        if record is None:
            record = ChannelPlan(year=payload.year, channel=payload.channel, monthly_plan=payload.monthly_plan)
            database.add(record)
        else:
            record.monthly_plan = payload.monthly_plan
            record.updated_at = datetime.now(timezone.utc)
        database.commit()
        database.refresh(record)
        result = plan_data(record)
    return result


@router.delete("/{year}/{channel}")
def delete_plan(year: int, channel: str) -> dict[str, object]:
    if year == 2026:
        raise HTTPException(status_code=409, detail="The existing 2026 plan is protected and cannot be deleted.")
    if channel not in PLAN_CHANNELS:
        raise HTTPException(status_code=422, detail="Unsupported plan channel.")
    ensure_plan_table()
    with SessionLocal() as database:
        record = database.query(ChannelPlan).filter(
            ChannelPlan.year == year,
            ChannelPlan.channel == channel,
        ).one_or_none()
        if record is None:
            raise HTTPException(status_code=404, detail="No saved plan exists for this year and channel.")
        database.delete(record)
        database.commit()
    return {"deleted": True, "year": year, "channel": channel}


@router.get("/categories")
def list_category_plans(year: int) -> dict[str, object]:
    if year < 2026 or year > 9999:
        raise HTTPException(status_code=422, detail="Year must be 2026 or later.")
    ensure_plan_table()
    with SessionLocal() as database:
        saved = {
            record.category: record
            for record in database.query(CategoryPlan).filter(CategoryPlan.year == year).all()
        }
        if year == 2026:
            saved = {}
        resolved = dict(DEFAULT_2026_CATEGORY_PLANS) if year == 2026 else {category: 0 for category in CATEGORY_PLAN_NAMES}
        resolved.update({category: int(record.monthly_plan) for category, record in saved.items()})
        plans = [{
            "year": year,
            "category": category,
            "monthly_plan": resolved[category],
            "quarterly_plan": resolved[category] * 3,
            "yearly_plan": resolved[category] * 12,
            "saved": category in saved,
            "protected_default": year == 2026 and category not in saved,
        } for category in CATEGORY_PLAN_NAMES]
    return {"year": year, "categories": list(CATEGORY_PLAN_NAMES), "plans": plans}


@router.put("/categories")
def save_category_plan(payload: CategoryPlanWrite) -> dict[str, object]:
    if payload.category not in CATEGORY_PLAN_NAMES:
        raise HTTPException(status_code=422, detail="Unsupported plan category.")
    if payload.year == 2026:
        raise HTTPException(status_code=409, detail="The existing 2026 category plan is protected and cannot be changed.")
    ensure_plan_table()
    with SessionLocal() as database:
        record = database.query(CategoryPlan).filter(
            CategoryPlan.year == payload.year,
            CategoryPlan.category == payload.category,
        ).one_or_none()
        if record is None:
            record = CategoryPlan(year=payload.year, category=payload.category, monthly_plan=payload.monthly_plan)
            database.add(record)
        else:
            record.monthly_plan = payload.monthly_plan
            record.updated_at = datetime.now(timezone.utc)
        database.commit()
        database.refresh(record)
        monthly = int(record.monthly_plan)
    return {"year": payload.year, "category": payload.category, "monthly_plan": monthly, "quarterly_plan": monthly * 3, "yearly_plan": monthly * 12, "saved": True}


@router.delete("/categories/{year}/{category}")
def delete_category_plan(year: int, category: str) -> dict[str, object]:
    if year == 2026:
        raise HTTPException(status_code=409, detail="The existing 2026 category plan is protected and cannot be deleted.")
    if category not in CATEGORY_PLAN_NAMES:
        raise HTTPException(status_code=422, detail="Unsupported plan category.")
    ensure_plan_table()
    with SessionLocal() as database:
        record = database.query(CategoryPlan).filter(
            CategoryPlan.year == year,
            CategoryPlan.category == category,
        ).one_or_none()
        if record is None:
            raise HTTPException(status_code=404, detail="No saved category plan exists for this year and category.")
        database.delete(record)
        database.commit()
    return {"deleted": True, "year": year, "category": category}


def plan_data_version() -> tuple[int, str]:
    ensure_plan_table()
    with SessionLocal() as database:
        channel_count, channel_updated = database.query(func.count(ChannelPlan.id), func.max(ChannelPlan.updated_at)).one()
        category_count, category_updated = database.query(func.count(CategoryPlan.id), func.max(CategoryPlan.updated_at)).one()
    latest = max((value for value in (channel_updated, category_updated) if value), default=None)
    return int(channel_count or 0) + int(category_count or 0), latest.isoformat() if latest else ""


def saved_plan_years() -> set[int]:
    ensure_plan_table()
    with SessionLocal() as database:
        return {
            year for (year,) in database.query(ChannelPlan.year).distinct().all()
        } | {
            year for (year,) in database.query(CategoryPlan.year).distinct().all()
        }
