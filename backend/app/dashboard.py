from collections import defaultdict
from contextlib import nullcontext
from datetime import datetime, timedelta
from functools import lru_cache
from threading import Lock
from time import monotonic
from typing import Any

import pandas as pd
from fastapi import APIRouter, HTTPException
from sqlalchemy import func

from app.database.database import SessionLocal
from app.database.models import AmazonDatasetRow, DirectSalesDatasetRow, DSGDatasetRow, SFHDatasetRow, UploadHistory
from app.calculations.amounts import sfh_amount_from_record, sfh_is_inr_currency

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

DASHBOARD_CACHE_TTL_SECONDS = 300
_dashboard_response_cache: dict[tuple[object, ...], tuple[float, dict[str, object]]] = {}
_dashboard_cache_lock = Lock()
_dashboard_source_cache: dict[str, object] = {}
_dashboard_source_lock = Lock()
_channel_metrics_cache: dict[str, object] = {}
_channel_metrics_lock = Lock()


def _dashboard_data_version() -> tuple[int, str]:
    """Cheaply invalidate cached visuals whenever upload history changes."""
    with SessionLocal() as database:
        count, latest_upload = database.query(
            func.count(UploadHistory.upload_id), func.max(UploadHistory.uploaded_at)
        ).one()
    return int(count or 0), latest_upload.isoformat() if latest_upload else ""


def _dashboard_source_snapshot() -> dict[str, object]:
    """Load every dashboard source once and reuse it across all visual builders."""
    version = _dashboard_data_version()
    with _dashboard_source_lock:
        if _dashboard_source_cache.get("version") == version:
            return _dashboard_source_cache
        with SessionLocal() as database:
            history = database.query(UploadHistory).all()
            snapshot: dict[str, object] = {
                "version": version,
                "history": history,
                "upload_dates": {item.upload_id: item.uploaded_at for item in history},
                "DSGDatasetRow": database.query(DSGDatasetRow).all(),
                "SFHDatasetRow": database.query(SFHDatasetRow).all(),
                "AmazonDatasetRow": database.query(AmazonDatasetRow).all(),
                "DirectSalesDatasetRow": database.query(DirectSalesDatasetRow).all(),
            }
        _dashboard_source_cache.clear()
        _dashboard_source_cache.update(snapshot)
        with _channel_metrics_lock:
            _channel_metrics_cache.clear()
        _parsed_month.cache_clear()
        return _dashboard_source_cache


def _cached_rows(model) -> list:
    snapshot = _dashboard_source_cache or _dashboard_source_snapshot()
    return snapshot[model.__name__]  # type: ignore[return-value]


def _cached_upload_dates() -> dict[str, datetime]:
    snapshot = _dashboard_source_cache or _dashboard_source_snapshot()
    return snapshot["upload_dates"]  # type: ignore[return-value]

CATEGORY_ORDER = ("Web Version", "Audio Device", "Pen Drive", "Books")
CATEGORY_MONTHLY_PLANS = {
    "Books": 200000,
    "Web Version": 150000,
    "Audio Device": 100000,
    "Pen Drive": 50000,
}
INDIAN_STATE_NAMES = {
    "AN": "Andaman and Nicobar Islands", "AP": "Andhra Pradesh", "AR": "Arunachal Pradesh",
    "AS": "Assam", "BR": "Bihar", "CH": "Chandigarh", "CG": "Chhattisgarh",
    "CT": "Chhattisgarh", "DN": "Dadra and Nagar Haveli and Daman and Diu",
    "DD": "Dadra and Nagar Haveli and Daman and Diu", "DL": "Delhi",
    "GA": "Goa", "GJ": "Gujarat",
    "HR": "Haryana", "HP": "Himachal Pradesh", "JK": "Jammu and Kashmir",
    "JH": "Jharkhand", "KA": "Karnataka", "KL": "Kerala", "LA": "Ladakh",
    "LD": "Lakshadweep", "MP": "Madhya Pradesh", "MH": "Maharashtra",
    "MN": "Manipur", "ML": "Meghalaya", "MZ": "Mizoram", "NL": "Nagaland",
    "OD": "Odisha", "OR": "Odisha", "PY": "Puducherry", "PB": "Punjab",
    "RJ": "Rajasthan", "SK": "Sikkim", "TN": "Tamil Nadu", "TS": "Telangana",
    "TG": "Telangana", "TR": "Tripura", "UP": "Uttar Pradesh",
    "UK": "Uttarakhand", "UT": "Uttarakhand", "WB": "West Bengal",
}

COUNTRY_NAMES = {
    "AT": "Austria", "BR": "Brazil", "CA": "Canada", "FI": "Finland",
    "GB": "United Kingdom", "IN": "India", "LU": "Luxembourg",
    "US": "United States",
}

REGION_NAMES_BY_COUNTRY = {
    "IN": INDIAN_STATE_NAMES,
    "US": {
        "CA": "California", "FL": "Florida", "MN": "Minnesota",
        "NY": "New York", "OH": "Ohio", "TX": "Texas",
        "VA": "Virginia", "WA": "Washington",
    },
    "CA": {"ON": "Ontario"},
    "BR": {"PR": "Paraná"},
}

# Full names can be identified safely even when a source file has no country
# column. Only names that resolve unambiguously in the current supported data
# are included here; unknown abbreviations are never guessed.
REGION_COUNTRY_BY_NAME = {
    **{name.casefold(): (name, "India") for name in set(INDIAN_STATE_NAMES.values())},
    **{
        name.casefold(): (name, "United States")
        for name in set(REGION_NAMES_BY_COUNTRY["US"].values())
    },
    "ontario": ("Ontario", "Canada"),
    "parana": ("Paraná", "Brazil"),
    "paraná": ("Paraná", "Brazil"),
    "andhra pradesh (new)": ("Andhra Pradesh", "India"),
    "andhra pradesh(before division": ("Andhra Pradesh", "India"),
}


def _state_name(value: object, country_value: object = "") -> str:
    """Resolve a region using its country, without guessing ambiguous codes."""
    raw = str(value or "").strip()
    if not raw:
        return "Unknown/Invalid"

    country_code = str(country_value or "").strip().upper()
    country_name = COUNTRY_NAMES.get(country_code)
    if country_code:
        region_name = REGION_NAMES_BY_COUNTRY.get(country_code, {}).get(raw.upper())
        if region_name and country_name:
            return f"{region_name}, {country_name}"
        named_region = REGION_COUNTRY_BY_NAME.get(raw.casefold())
        if named_region and named_region[1] == country_name:
            return f"{named_region[0]}, {named_region[1]}"
        return "Unknown/Invalid"

    named_region = REGION_COUNTRY_BY_NAME.get(raw.casefold())
    if named_region:
        return f"{named_region[0]}, {named_region[1]}"
    return "Unknown/Invalid"
DATE_ALIASES = (
    "order date",
    "purchase date",
    "purchase-date",
    "issue date",
    "date",
    "created at",
    "created date",
    "order date & time",
    "order datetime",
)
def _normalise(value: object) -> str:
    return " ".join(str(value).strip().casefold().replace("_", " ").split())


def _row_value(data: dict[str, Any], aliases: tuple[str, ...]) -> object | None:
    values = {_normalise(key): value for key, value in data.items()}
    return next((values[alias] for alias in aliases if alias in values), None)


def _first_nonempty_row_value(data: dict[str, Any], aliases: tuple[str, ...]) -> object | None:
    """Return the first populated alias, allowing sparse export columns to fall back."""
    values = {_normalise(key): value for key, value in data.items()}
    return next((values[alias] for alias in aliases if alias in values and values[alias] not in (None, "")), None)


def _number(value: object) -> float:
    if value is None:
        return 0.0
    try:
        return float(str(value).replace(",", "").replace("₹", "").strip())
    except (TypeError, ValueError):
        return 0.0


def _direct_amount(row: DirectSalesDatasetRow) -> float:
    status = _row_value(row.row_data, ("status",))
    if str(status or "").strip().casefold() == "cancelled":
        return 0.0
    # row_data is authoritative so uploads saved before the dedicated Direct
    # Sales amount mapping also use the correct net-of-tax business value.
    value = _row_value(row.row_data, ("without tax total",))
    return _number(value if value is not None else row.amount)


def _direct_sales_channel(row: DirectSalesDatasetRow) -> str:
    """Return the shared dashboard channel mapping for a Direct Sales row."""
    private_notes = str(_row_value(row.row_data, ("private notes",)) or "").casefold()
    # Private Notes is authoritative for the two named channels. Checking it
    # first also classifies datasets saved before Language Lab was introduced.
    if "language lab" in private_notes:
        return "Language Lab"
    classification = str(
        _row_value(row.row_data, ("sales classification",))
        or (
            "Stall Sales"
            if "stall" in private_notes
            else "Bulk Sales"
            if _number(_row_value(row.row_data, ("mapped quantity",))) > 10
            else "Direct Sales"
        )
    )
    return classification if classification in {"Direct Sales", "Stall Sales", "Bulk Sales", "Language Lab"} else "Direct Sales"
    try:
        return float(str(value).replace(",", "").replace("₹", "").strip())
    except (TypeError, ValueError):
        return 0.0


def _amazon_is_cancelled(row: AmazonDatasetRow) -> bool:
    """Excluded Amazon statuses remain stored but never contribute to MIS values."""
    status = _row_value(row.row_data, ("order status", "order-status"))
    return str(status or "").strip().casefold() in {
        "cancelled", "shipped - returning to seller",
    }


def _dsg_is_completed(row: DSGDatasetRow) -> bool:
    """Only completed DSG orders contribute to calculations and reports."""
    status = _row_value(row.row_data, ("order status",))
    return str(status or "").strip().casefold() == "completed"


def _order_identifier(channel: str, row) -> str:
    """Return the normalized business order identifier for a valid channel row."""
    if channel == "DSG":
        value = row.order_number or _row_value(row.row_data, ("order number",))
    elif channel == "SFH":
        value = _row_value(row.row_data, ("invoice no.", "invoice no", "invoice number"))
    elif channel == "Direct Sales":
        value = row.order_number or _row_value(row.row_data, ("invoice number",))
    else:
        value = _row_value(row.row_data, ("amazon-order-id", "amazon order id"))
    return str(value or "").strip().casefold()


def _unique_order_count(rows) -> int:
    """Count unique valid orders per channel without cross-channel ID collisions."""
    orders: set[tuple[str, str]] = set()
    for channel, row, _ in rows:
        if channel == "DSG" and not _dsg_is_completed(row):
            continue
        if channel == "Amazon" and _amazon_is_cancelled(row):
            continue
        identifier = _order_identifier(channel, row)
        if identifier:
            orders.add((channel, identifier))
    return len(orders)


def _period_order_counts(grain: str, period: str, year: int) -> dict[str, int]:
    """Return unique KPI order counts by channel using the report rules."""
    selected_months = (
        {int(value) for value in period.split(",")}
        if grain == "monthly" else set()
    )

    def included(month_key: str) -> bool:
        row_year, row_month = (int(value) for value in month_key.split("-"))
        if grain == "monthly":
            return row_year == year and row_month in selected_months
        if grain == "quarterly":
            first_month = (int(period) - 1) * 3 + 1
            return row_year == year and first_month <= row_month <= first_month + 2
        return row_year == year

    models = (
        ("DSG", DSGDatasetRow), ("SFH", SFHDatasetRow),
        ("Amazon", AmazonDatasetRow), ("Direct Sales", DirectSalesDatasetRow),
    )
    current = datetime.now()
    rows_by_channel: dict[str, list] = {name: [] for name, _ in models}
    with nullcontext():
        upload_dates = _cached_upload_dates()
        for channel_name, model in models:
            for row in _cached_rows(model):
                month_key = _month(row.row_data, upload_dates.get(row.upload_id, current))
                if included(month_key):
                    rows_by_channel[channel_name].append((channel_name, row, month_key))
    return {
        channel_name: _unique_order_count(rows)
        for channel_name, rows in rows_by_channel.items()
    }


def _dsg_pnl_amount(row: DSGDatasetRow, charged_orders: set[str]) -> float:
    """Return DSG P&L value, allocating filled-down shipping once per order."""
    data = row.row_data
    basic_source = _row_value(data, ("item cost × quantity", "item cost x quantity"))
    basic_value = _number(basic_source if basic_source is not None else row.amount)
    discount = _number(_row_value(data, ("cart discount amount",)))
    order_number = str(
        row.order_number or _row_value(data, ("order number",)) or ""
    ).strip().casefold()
    include_shipping = order_number not in charged_orders
    if include_shipping:
        charged_orders.add(order_number)
    shipping = (
        _number(_row_value(data, ("order shipping amount",)))
        if include_shipping else 0.0
    )
    return basic_value + shipping + discount


@lru_cache(maxsize=8192)
def _parsed_month(value: object) -> str | None:
    parsed = pd.to_datetime(value, errors="coerce")
    return None if pd.isna(parsed) else parsed.strftime("%Y-%m")


def _month(data: dict[str, Any], fallback: datetime) -> str:
    value = _row_value(data, DATE_ALIASES)
    if value is not None:
        try:
            parsed_month = _parsed_month(value)
        except TypeError:
            # Unexpected non-hashable date values retain the original parsing path.
            parsed = pd.to_datetime(value, errors="coerce")
            parsed_month = None if pd.isna(parsed) else parsed.strftime("%Y-%m")
        if parsed_month is not None:
            return parsed_month
    return fallback.strftime("%Y-%m")


def _empty_month_metrics() -> defaultdict[str, Any]:
    values: defaultdict[str, Any] = defaultdict(float)
    values["zero_categories"] = defaultdict(float)
    values["taxable_categories"] = defaultdict(float)
    return values


def _empty_metrics() -> dict[str, Any]:
    return {
        "zero_rated": 0.0,
        "exempted": 0.0,
        "taxable": 0.0,
        "pnl": 0.0,
        "zero_categories": defaultdict(float),
        "taxable_categories": defaultdict(float),
        "monthly": defaultdict(_empty_month_metrics),
        "records": 0,
    }


def _add_row(
    metrics: dict[str, Any],
    *,
    category: str,
    amount: float,
    is_foreign: bool,
    month: str,
) -> None:
    if amount == 0:
        return
    metrics["records"] += 1
    # Tax buckets are mutually exclusive. A foreign sale is zero-rated and
    # must not also be counted as exempted or taxable in Sales as per P&L.
    zero_rated = amount if is_foreign else 0.0
    exempted = amount if not is_foreign and category == "Books" else 0.0
    taxable = (
        amount
        if not is_foreign and category in {"Web Version", "Audio Device", "Pen Drive"}
        else 0.0
    )
    pnl = zero_rated + exempted + taxable
    metrics["zero_rated"] += zero_rated
    metrics["exempted"] += exempted
    metrics["taxable"] += taxable
    metrics["pnl"] += pnl
    if zero_rated:
        metrics["zero_categories"][category] += zero_rated
    if taxable:
        metrics["taxable_categories"][category] += taxable
    for key, value in (
        ("zero_rated", zero_rated),
        ("exempted", exempted),
        ("taxable", taxable),
        ("pnl", pnl),
    ):
        metrics["monthly"][month][key] += value
    if zero_rated:
        metrics["monthly"][month]["zero_categories"][category] += zero_rated
    if taxable:
        metrics["monthly"][month]["taxable_categories"][category] += taxable


def _merge_month(target: dict[str, Any], month: str, values: dict[str, Any]) -> None:
    for metric in ("zero_rated", "exempted", "taxable", "pnl"):
        value = values[metric]
        target[metric] += value
        target["monthly"][month][metric] += value
    for category, value in values["zero_categories"].items():
        target["zero_categories"][category] += value
        target["monthly"][month]["zero_categories"][category] += value
    for category, value in values["taxable_categories"].items():
        target["taxable_categories"][category] += value
        target["monthly"][month]["taxable_categories"][category] += value
    target["records"] += 1


def _for_period(
    metrics: dict[str, Any], grain: str, period: str, selected_year: int | None = None
) -> dict[str, Any]:
    selected = _empty_metrics()
    target_year = selected_year or datetime.now().year
    selected_months = {int(value) for value in period.split(",")} if grain == "monthly" else set()
    for month, values in metrics["monthly"].items():
        year, month_number = month.split("-")
        matches = (
            (grain == "monthly" and year == str(target_year) and int(month_number) in selected_months)
            or (
                grain == "quarterly"
                and year == str(target_year)
                and ((int(month_number) - 1) // 3) + 1 == int(period)
            )
            or (grain == "yearly" and year == period)
        )
        if matches:
            _merge_month(selected, month, values)
    return selected


def _previous_period(grain: str, period: str) -> tuple[int, set[int], str]:
    current_year = datetime.now().year
    if grain == "monthly":
        month_number = int(period)
        if month_number == 1:
            return current_year - 1, {12}, "Dec"
        previous_month = month_number - 1
        return current_year, {previous_month}, datetime(2000, previous_month, 1).strftime("%b")
    if grain == "quarterly":
        quarter = int(period)
        if quarter == 1:
            return current_year - 1, {10, 11, 12}, "Q4"
        previous_quarter = quarter - 1
        first_month = (previous_quarter - 1) * 3 + 1
        return current_year, {first_month, first_month + 1, first_month + 2}, f"Q{previous_quarter}"
    previous_year = int(period) - 1
    return previous_year, set(range(1, 13)), str(previous_year)


def _for_exact_months(
    metrics: dict[str, Any], year: int, months: set[int]
) -> tuple[dict[str, Any], bool]:
    selected = _empty_metrics()
    has_data = False
    for month, values in metrics["monthly"].items():
        month_year, month_number = month.split("-")
        if int(month_year) == year and int(month_number) in months:
            has_data = True
            _merge_month(selected, month, values)
    return selected, has_data


def _category_actuals(metrics: dict[str, Any]) -> dict[str, float]:
    return {
        category: (
            metrics["zero_categories"][category]
            + metrics["taxable_categories"][category]
            + (metrics["exempted"] if category == "Books" else 0.0)
        )
        for category in CATEGORY_MONTHLY_PLANS
    }


def _load_channel_metrics() -> dict[str, dict[str, Any]]:
    snapshot = _dashboard_source_cache or _dashboard_source_snapshot()
    version = snapshot["version"]
    with _channel_metrics_lock:
        if _channel_metrics_cache.get("version") == version:
            return _channel_metrics_cache["metrics"]  # type: ignore[return-value]

    channels = {
        "dsg": _empty_metrics(),
        "sfh": _empty_metrics(),
        "amazon": _empty_metrics(),
        "direct": _empty_metrics(),
    }
    with nullcontext():
        upload_dates = _cached_upload_dates()
        dsg_charged_orders: set[str] = set()
        for row in _cached_rows(DSGDatasetRow):
            if not _dsg_is_completed(row):
                continue
            uploaded_at = upload_dates.get(row.upload_id, datetime.now())
            country_code = _row_value(row.row_data, ("country code (billing)",))
            _add_row(
                channels["dsg"],
                category=row.category or "",
                amount=_dsg_pnl_amount(row, dsg_charged_orders),
                is_foreign=str(country_code).strip().upper() != "IN",
                month=_month(row.row_data, uploaded_at),
            )
        for row in _cached_rows(SFHDatasetRow):
            uploaded_at = upload_dates.get(row.upload_id, datetime.now())
            currency = _row_value(row.row_data, ("currency",))
            _add_row(
                channels["sfh"],
                category=row.category or "Web Version",
                amount=_number(sfh_amount_from_record(row.row_data)),
                is_foreign=not sfh_is_inr_currency(currency),
                month=_month(row.row_data, uploaded_at),
            )
        for row in _cached_rows(AmazonDatasetRow):
            if _amazon_is_cancelled(row):
                continue
            uploaded_at = upload_dates.get(row.upload_id, datetime.now())
            _add_row(
                channels["amazon"],
                category="Books",
                amount=_number(row.amount),
                is_foreign=str(row.currency or "").strip().upper() != "INR",
                month=_month(row.row_data, uploaded_at),
            )
        for row in _cached_rows(DirectSalesDatasetRow):
            uploaded_at = upload_dates.get(row.upload_id, datetime.now())
            _add_row(
                channels["direct"],
                category=row.category or "",
                amount=_direct_amount(row),
                # Direct Sales is always domestic for MIS tax reporting.
                is_foreign=False,
                month=_month(row.row_data, uploaded_at),
            )
    with _channel_metrics_lock:
        _channel_metrics_cache.clear()
        _channel_metrics_cache.update({"version": version, "metrics": channels})
    return channels


def _direct_sales_classification(
    grain: str,
    period: str,
    selected_year: int,
) -> dict[str, float]:
    current = datetime.now()
    selected_months = (
        {int(value) for value in period.split(",")}
        if grain == "monthly"
        else set()
    )

    def included(month_key: str) -> bool:
        row_year, row_month = (int(value) for value in month_key.split("-"))
        if grain == "monthly":
            return row_year == selected_year and row_month in selected_months
        if grain == "quarterly":
            first_month = (int(period) - 1) * 3 + 1
            return row_year == selected_year and first_month <= row_month <= first_month + 2
        cutoff = current.month
        if cutoff >= 4:
            return row_year == selected_year and 4 <= row_month <= cutoff
        return (
            row_year == selected_year - 1 and row_month >= 4
        ) or (
            row_year == selected_year and row_month <= cutoff
        )

    totals = {"Direct Sales": 0.0, "Stall Sales": 0.0, "Bulk Sales": 0.0, "Language Lab": 0.0}
    with nullcontext():
        upload_dates = _cached_upload_dates()
        for row in _cached_rows(DirectSalesDatasetRow):
            month = _month(row.row_data, upload_dates.get(row.upload_id, current))
            if not included(month):
                continue
            classification = _direct_sales_channel(row)
            totals[classification] += _direct_amount(row)
    totals["Total Direct Sales"] = sum(
        totals[channel] for channel in ("Direct Sales", "Stall Sales", "Bulk Sales")
    )
    return {key: _rounded(value) for key, value in totals.items()}


def _language_lab_monthly() -> dict[str, float]:
    """Return Language Lab sales by month for Grand Total sales trends."""
    totals: dict[str, float] = defaultdict(float)
    current = datetime.now()
    with nullcontext():
        upload_dates = _cached_upload_dates()
        for row in _cached_rows(DirectSalesDatasetRow):
            if _direct_sales_channel(row) != "Language Lab":
                continue
            month = _month(row.row_data, upload_dates.get(row.upload_id, current))
            totals[month] += _direct_amount(row)
    return totals


def _period_pnl(
    metrics: dict[str, Any],
    grain: str,
    period: str,
    selected_year: int,
) -> float:
    """Return P&L for the same calendar/fiscal window used by performance tables."""
    current = datetime.now()
    selected_months = (
        {int(value) for value in period.split(",")}
        if grain == "monthly"
        else set()
    )
    total = 0.0
    for month_key, values in metrics["monthly"].items():
        row_year, row_month = (int(value) for value in month_key.split("-"))
        if grain == "monthly":
            included = row_year == selected_year and row_month in selected_months
        elif grain == "quarterly":
            first_month = (int(period) - 1) * 3 + 1
            included = (
                row_year == selected_year
                and first_month <= row_month <= first_month + 2
            )
        else:
            cutoff = current.month
            included = (
                row_year == selected_year and 4 <= row_month <= cutoff
                if cutoff >= 4
                else (
                    row_year == selected_year - 1 and row_month >= 4
                ) or (
                    row_year == selected_year and row_month <= cutoff
                )
            )
        if included:
            total += float(values["pnl"])
    return _rounded(total)


def _product_rankings(
    channel: str,
    grain: str,
    period: str,
    selected_year: int,
) -> dict[str, list[dict[str, object]]]:
    current = datetime.now()
    selected_months = (
        {int(value) for value in period.split(",")}
        if grain == "monthly"
        else set()
    )

    def included(month_key: str) -> bool:
        row_year, row_month = (int(value) for value in month_key.split("-"))
        if grain == "monthly":
            return row_year == selected_year and row_month in selected_months
        if grain == "quarterly":
            first_month = (int(period) - 1) * 3 + 1
            return row_year == selected_year and row_month in {
                first_month, first_month + 1, first_month + 2
            }
        cutoff = current.month
        if cutoff >= 4:
            return row_year == selected_year and 4 <= row_month <= cutoff
        return (
            row_year == selected_year - 1 and row_month >= 4
        ) or (
            row_year == selected_year and row_month <= cutoff
        )

    totals: dict[str, dict[str, float]] = {
        "dsg": defaultdict(float),
        "sfh": defaultdict(float),
        "amazon": defaultdict(float),
        "direct": defaultdict(float),
    }
    labels: dict[str, dict[str, str]] = {"dsg": {}, "sfh": {}, "amazon": {}, "direct": {}}
    details: list[dict[str, object]] = []

    def add_detail(channel_label: str, row: object, month_key: str, description: str, total_value: float) -> None:
        data = getattr(row, "row_data", {}) or {}
        year_value, month_value = month_key.split("-")
        quantity = _number(_row_value(data, ("quantity", "qty", "item quantity")))
        shipping = _number(_row_value(data, ("shipping", "shipping amount", "shipping charges")))
        discount = _number(_row_value(data, ("discount", "discount amount")))
        taxable = _number(_row_value(data, ("taxable value", "without tax total", "basic value")))
        tax = _number(_row_value(data, ("tax", "tax amount", "gst", "total tax")))
        basic = _number(_row_value(data, ("basic value", "item cost", "without tax total")))
        details.append({
            "year": int(year_value), "month": int(month_value), "channel": channel_label,
            "category": str(getattr(row, "category", "") or ""), "orders": 1,
            "quantity": quantity, "description": description, "basic_value": _rounded(basic),
            "shipping": _rounded(shipping), "discount": _rounded(discount),
            "taxable_value": _rounded(taxable), "tax": _rounded(tax),
            "total_invoice_value": _rounded(total_value),
        })
    with nullcontext():
        upload_dates = _cached_upload_dates()
        if channel in {"all", "dsg"}:
            dsg_charged_orders: set[str] = set()
            for row in _cached_rows(DSGDatasetRow):
                if not _dsg_is_completed(row):
                    continue
                month = _month(
                    row.row_data,
                    upload_dates.get(row.upload_id, current),
                )
                product = str(row.product_name or "").strip()
                if product and included(month):
                    key = product.casefold()
                    labels["dsg"].setdefault(key, product)
                    amount = _dsg_pnl_amount(row, dsg_charged_orders)
                    totals["dsg"][key] += amount
                    add_detail("DSG", row, month, product, amount)
        if channel in {"all", "sfh"}:
            for row in _cached_rows(SFHDatasetRow):
                month = _month(
                    row.row_data,
                    upload_dates.get(row.upload_id, current),
                )
                course = str(row.course or row.product_name or "").strip()
                if course and included(month):
                    key = course.casefold()
                    labels["sfh"].setdefault(key, course)
                    amount = _number(sfh_amount_from_record(row.row_data))
                    totals["sfh"][key] += amount
                    add_detail("SFH", row, month, course, amount)
        if channel in {"all", "amazon"}:
            for row in _cached_rows(AmazonDatasetRow):
                if _amazon_is_cancelled(row):
                    continue
                month = _month(row.row_data, upload_dates.get(row.upload_id, current))
                product = str(row.product_name or "").strip()
                if product and included(month):
                    key = product.casefold()
                    labels["amazon"].setdefault(key, product)
                    amount = _number(row.amount)
                    totals["amazon"][key] += amount
                    add_detail("Amazon", row, month, product, amount)
        if channel in {"all", "direct"}:
            for row in _cached_rows(DirectSalesDatasetRow):
                month = _month(row.row_data, upload_dates.get(row.upload_id, current))
                product = str(row.product_name or "").strip()
                if product and included(month):
                    key = product.casefold()
                    labels["direct"].setdefault(key, product)
                    amount = _direct_amount(row)
                    totals["direct"][key] += amount
                    add_detail("Direct Sales", row, month, product, amount)

    channel_labels = {
        "dsg": ("DSG", "Products"),
        "sfh": ("SFH", "Courses"),
        "amazon": ("Amazon", "Products"),
        "direct": ("Direct Sales", "Products"),
    }
    requested_channels = ("dsg", "sfh", "amazon", "direct") if channel == "all" else (channel,)
    sections = []
    for channel_id in requested_channels:
        ranked = [
            {"name": labels[channel_id][key], "amount": _rounded(amount)}
            for key, amount in totals[channel_id].items()
        ]
        label, item_label = channel_labels[channel_id]
        sections.append(
            {
                "id": channel_id,
                "label": label,
                "item_label": item_label,
                "top": sorted(
                    ranked,
                    key=lambda item: (-float(item["amount"]), str(item["name"]).casefold()),
                )[:5],
                "bottom": sorted(
                    ranked,
                    key=lambda item: (float(item["amount"]), str(item["name"]).casefold()),
                )[:5],
            }
        )
    return {"channels": sections, "details": details}


def _customer_performance(
    channel: str,
    grain: str,
    period: str,
    selected_year: int,
) -> dict[str, object]:
    current = datetime.now()
    selected_months = (
        {int(value) for value in period.split(",")}
        if grain == "monthly"
        else set()
    )

    def included(month_key: str) -> bool:
        row_year, row_month = (int(value) for value in month_key.split("-"))
        if grain == "monthly":
            return row_year == selected_year and row_month in selected_months
        if grain == "quarterly":
            first_month = (int(period) - 1) * 3 + 1
            return row_year == selected_year and first_month <= row_month <= first_month + 2
        cutoff = current.month
        if cutoff >= 4:
            return row_year == selected_year and 4 <= row_month <= cutoff
        return (
            row_year == selected_year - 1 and row_month >= 4
        ) or (
            row_year == selected_year and row_month <= cutoff
        )

    email_counts: dict[str, int] = defaultdict(int)
    with nullcontext():
        upload_dates = _cached_upload_dates()
        if channel in {"all", "dsg"}:
            for row in _cached_rows(DSGDatasetRow):
                if not _dsg_is_completed(row):
                    continue
                month = _month(row.row_data, upload_dates.get(row.upload_id, current))
                email = str(_row_value(row.row_data, ("email (billing)",)) or "").strip().casefold()
                if email and included(month):
                    email_counts[email] += 1
        if channel in {"all", "sfh"}:
            for row in _cached_rows(SFHDatasetRow):
                month = _month(row.row_data, upload_dates.get(row.upload_id, current))
                email = str(_row_value(row.row_data, ("email",)) or "").strip().casefold()
                if email and included(month):
                    email_counts[email] += 1
        if channel in {"all", "direct"}:
            for row in _cached_rows(DirectSalesDatasetRow):
                month = _month(row.row_data, upload_dates.get(row.upload_id, current))
                email = str(
                    _first_nonempty_row_value(row.row_data, (
                        "email", "customer email", "email (billing)", "client email",
                        "client name", "customer name", "customer display name",
                        "contact name", "billing name", "company name",
                    )) or ""
                ).strip().casefold()
                if email and included(month):
                    email_counts[email] += 1
        if channel in {"all", "amazon"}:
            for row in _cached_rows(AmazonDatasetRow):
                if _amazon_is_cancelled(row):
                    continue
                month = _month(row.row_data, upload_dates.get(row.upload_id, current))
                email = str(_row_value(row.row_data, ("buyer email", "email")) or "").strip().casefold()
                if email and included(month):
                    email_counts[email] += 1

    unique_customers = sum(count == 1 for count in email_counts.values())
    repeat_customers = sum(count > 1 for count in email_counts.values())
    total_customers = unique_customers + repeat_customers
    unique_percent = (unique_customers / total_customers * 100) if total_customers else 0
    return {
        "total_customers": total_customers,
        "unique_customers": unique_customers,
        "repeat_customers": repeat_customers,
        "unique_percent": round(unique_percent, 1),
        "repeat_percent": round(100 - unique_percent, 1) if total_customers else 0,
    }


def _customer_mix_context(channel: str, grain: str, period: str, selected_year: int) -> dict[str, object]:
    """Build customer-mix trend and AOV context from the same cached order rows.

    The existing headline counts deliberately remain untouched.  For the new
    monthly context, a customer is new/returning using that month's existing
    count rule (one identified row/new, more than one/returning).
    """
    current = datetime.now()
    upload_dates = _cached_upload_dates()
    events: list[tuple[str, str, float, str]] = []
    sources = (
        ("dsg", DSGDatasetRow), ("sfh", SFHDatasetRow),
        ("amazon", AmazonDatasetRow), ("direct", DirectSalesDatasetRow),
    )
    email_aliases = {
        "dsg": ("email (billing)",), "sfh": ("email",),
        "amazon": ("buyer email", "email"),
        "direct": ("email", "customer email", "email (billing)", "client email", "client name", "customer name", "customer display name", "contact name", "billing name", "company name"),
    }
    for source, model in sources:
        if channel not in {"all", source}:
            continue
        charged_orders: set[str] = set()
        for row in _cached_rows(model):
            if source == "dsg" and not _dsg_is_completed(row):
                continue
            if source == "amazon" and _amazon_is_cancelled(row):
                continue
            email = str(_first_nonempty_row_value(row.row_data, email_aliases[source]) or "").strip().casefold()
            if not email:
                continue
            if source == "dsg":
                amount, label = _dsg_pnl_amount(row, charged_orders), "DSG"
            elif source == "sfh":
                amount, label = _number(sfh_amount_from_record(row.row_data)), "SFH"
            elif source == "amazon":
                amount, label = _number(row.amount), "Amazon"
            else:
                amount, label = _direct_amount(row), "Direct Sales"
            events.append((_month(row.row_data, upload_dates.get(row.upload_id, current)), email, amount, f"{label}:{_order_identifier(label, row) or row.id}"))

    if grain == "monthly":
        anchor_month = max(int(value) for value in period.split(","))
        anchor = datetime(selected_year, anchor_month, 1)
    else:
        anchor = datetime.now().replace(day=1)
    months = []
    for offset in range(5, -1, -1):
        month = (anchor.replace(day=1) - timedelta(days=1)) if offset else anchor
        for _ in range(max(offset - 1, 0)):
            month = month.replace(day=1) - timedelta(days=1)
        months.append(month.strftime("%Y-%m"))

    trend = []
    monthly_aov: dict[str, dict[str, float]] = {}
    for month_key in months:
        rows = [(email, amount, order) for month, email, amount, order in events if month == month_key]
        counts: dict[str, int] = defaultdict(int)
        for email, _, _ in rows:
            counts[email] += 1
        new = sum(count == 1 for count in counts.values())
        returning = sum(count > 1 for count in counts.values())
        total = new + returning
        grouped: dict[str, dict[str, object]] = {"new": {"amount": 0.0, "orders": set()}, "returning": {"amount": 0.0, "orders": set()}}
        for email, amount, order in rows:
            cohort = "new" if counts[email] == 1 else "returning"
            grouped[cohort]["amount"] = float(grouped[cohort]["amount"]) + amount
            grouped[cohort]["orders"].add(order)  # type: ignore[union-attr]
        monthly_aov[month_key] = {
            cohort: _rounded(float(values["amount"]) / len(values["orders"])) if values["orders"] else 0.0
            for cohort, values in grouped.items()
        }
        year, month = (int(value) for value in month_key.split("-"))
        trend.append({"key": month_key, "label": datetime(year, month, 1).strftime("%b"), "new_percent": _rounded(new / total * 100) if total else 0.0, "returning_percent": _rounded(returning / total * 100) if total else 0.0})
    current_aov = monthly_aov.get(months[-1], {"new": 0.0, "returning": 0.0})
    repeat_delta = _rounded(trend[-1]["returning_percent"] - trend[-2]["returning_percent"]) if len(trend) > 1 else 0.0
    recent = [float(point["returning_percent"]) for point in trend[-3:]]
    is_declining = len(recent) == 3 and recent[0] > recent[1] > recent[2]
    return {"trend": trend, "aov": current_aov, "repeat_rate_delta": repeat_delta, "repeat_rate_declining": is_declining}


def _state_performance(
    channel: str, grain: str, period: str, selected_year: int, include_details: bool = False
) -> list[dict[str, object]] | tuple[list[dict[str, object]], list[dict[str, object]]]:
    selected_months = {int(value) for value in period.split(",")} if grain == "monthly" else set()

    def included(month_key: str) -> bool:
        row_year, row_month = (int(value) for value in month_key.split("-"))
        if grain == "monthly":
            return row_year == selected_year and row_month in selected_months
        if grain == "quarterly":
            first = (int(period) - 1) * 3 + 1
            return row_year == selected_year and first <= row_month <= first + 2
        return row_year == selected_year

    totals: dict[str, float] = defaultdict(float)
    state_orders: dict[str, set[tuple[str, str]]] = defaultdict(set)
    state_customers: dict[str, set[str]] = defaultdict(set)
    order_details: list[dict[str, object]] = []
    sfh_invoice_ids: set[str] = set()
    current = datetime.now()
    with nullcontext():
        upload_dates = _cached_upload_dates()
        sources = []
        if channel in {"all", "dsg"}:
            sources.append(("dsg", _cached_rows(DSGDatasetRow)))
        if channel in {"all", "sfh"}:
            sources.append(("sfh", _cached_rows(SFHDatasetRow)))
        if channel in {"all", "amazon"}:
            sources.append(("amazon", _cached_rows(AmazonDatasetRow)))
        if channel in {"all", "direct"}:
            sources.append(("direct", _cached_rows(DirectSalesDatasetRow)))
        dsg_charged_orders: set[str] = set()
        for source, source_rows in sources:
            for row in source_rows:
                if source == "dsg" and not _dsg_is_completed(row):
                    continue
                if source == "amazon" and _amazon_is_cancelled(row):
                    continue
                month_key = _month(row.row_data, upload_dates.get(row.upload_id, current))
                if not included(month_key):
                    continue
                if source == "dsg":
                    state = _state_name(
                        _row_value(row.row_data, ("state code (billing)",)),
                        _row_value(row.row_data, ("country code (billing)",)),
                    )
                    amount = _dsg_pnl_amount(row, dsg_charged_orders)
                elif source == "sfh":
                    state = _state_name(
                        _first_nonempty_row_value(row.row_data, ("place of supply", "state"))
                    )
                    amount = _number(sfh_amount_from_record(row.row_data))
                elif source == "amazon":
                    state = _state_name(
                        row.state,
                        _row_value(row.row_data, ("ship-country", "ship country", "country")),
                    )
                    amount = _number(row.amount)
                else:
                    state = _state_name(_row_value(row.row_data, ("client state",)))
                    amount = _direct_amount(row)
                state_key = state or "NA"
                totals[state_key] += amount
                channel_label = {"dsg": "DSG", "sfh": "SFH", "amazon": "Amazon", "direct": "Direct Sales"}[source]
                order_id = _order_identifier(channel_label, row)
                if order_id:
                    state_orders[state_key].add((channel_label, order_id))
                data = row.row_data or {}
                description = str(
                    getattr(row, "product_name", None)
                    or getattr(row, "course", None)
                    or _first_nonempty_row_value(data, ("description", "product name", "item name", "course"))
                    or ""
                ).strip()
                category = str(
                    getattr(row, "category", None)
                    or _first_nonempty_row_value(data, ("mapped category", "category"))
                    or ""
                ).strip()
                quantity = _number(_first_nonempty_row_value(data, ("quantity", "qty", "item quantity", "mapped quantity")))
                # SFH has no source quantity. Its detail QTY is one per unique Invoice No.
                if source == "sfh":
                    quantity = 1.0 if order_id and order_id not in sfh_invoice_ids else 0.0
                    if order_id:
                        sfh_invoice_ids.add(order_id)
                year_value, month_value = month_key.split("-")
                classification = (
                    "invalid" if state_key == "Unknown/Invalid"
                    else "india" if state_key.endswith(", India")
                    else "international"
                )
                order_details.append({
                    "year": int(year_value), "month": int(month_value),
                    "channel": channel_label, "order_id": order_id,
                    "category": category, "description": description,
                    "quantity": quantity, "sales": _rounded(amount),
                    "state": state_key, "classification": classification,
                })
                email_aliases = {
                    "dsg": ("email (billing)",), "sfh": ("email",),
                    "amazon": ("buyer email", "email"),
                    "direct": (
                        "email", "customer email", "email (billing)", "client email",
                        "client name", "customer name", "customer display name",
                        "contact name", "billing name", "company name",
                    ),
                }[source]
                customer = str(_first_nonempty_row_value(row.row_data, email_aliases) or "").strip().casefold()
                order_details[-1]["email"] = customer
                customer_name = str(_first_nonempty_row_value(row.row_data, (
                    "customer name", "customer display name", "client name", "contact name",
                    "billing name", "company name", "name", "buyer name",
                )) or "").strip()
                order_details[-1]["customer_name"] = customer_name
                if customer:
                    state_customers[state_key].add(customer)
    summary = [
        {"state": state, "amount": _rounded(amount), "orders": len(state_orders[state]), "customers": len(state_customers[state])}
        for state, amount in sorted(totals.items(), key=lambda item: (-item[1], item[0].casefold()))
    ]
    return (summary, order_details) if include_details else summary


def _rounded(value: float) -> float:
    return round(value, 2)


def _trend(metrics: dict[str, Any], metric: str, grain: str) -> list[float]:
    aggregated: dict[str, float] = defaultdict(float)
    for month, values in metrics["monthly"].items():
        year, month_number = month.split("-")
        if grain == "monthly":
            period = month
        elif grain == "quarterly":
            period = f"{year}-Q{((int(month_number) - 1) // 3) + 1}"
        else:
            period = year
        aggregated[period] += values[metric]
    return [_rounded(aggregated[period]) for period in sorted(aggregated)]


def _build_dashboard_kpis(
    channel: str = "all",
    grain: str = "monthly",
    period: str | None = None,
    year: int | None = None,
    latest: bool = False,
    comparison_grain: str | None = None,
    comparison_period: str | None = None,
    comparison_year: int | None = None,
) -> dict[str, object]:
    if grain not in {"monthly", "quarterly", "yearly"}:
        raise HTTPException(status_code=422, detail="Time grain must be monthly, quarterly, or yearly.")
    channel_metrics = _load_channel_metrics()
    current = datetime.now()
    available_years = sorted(
        {current.year}
        | {
            int(month.split("-")[0])
            for metrics in channel_metrics.values()
            for month in metrics["monthly"]
        },
        reverse=True,
    )
    if latest and grain == "monthly":
        populated_months = sorted(
            month
            for metrics in channel_metrics.values()
            for month, values in metrics["monthly"].items()
            if values["pnl"] != 0
        )
        if populated_months:
            latest_year, latest_month = (int(value) for value in populated_months[-1].split("-"))
            period = str(latest_month)
            year = latest_year
            previous_date = datetime(latest_year, latest_month, 1) - timedelta(days=1)
            comparison_grain = "monthly"
            comparison_period = str(previous_date.month)
            comparison_year = previous_date.year
    if period is None:
        period = (
            str(current.month)
            if grain == "monthly"
            else str(((current.month - 1) // 3) + 1)
            if grain == "quarterly"
            else str(current.year)
        )
    try:
        valid_period = (
            grain == "monthly"
            and bool(period)
            and all(1 <= int(value) <= 12 for value in period.split(","))
            or grain == "quarterly" and 1 <= int(period) <= 4
            or grain == "yearly" and int(period) in available_years
        )
    except ValueError:
        valid_period = False
    if not valid_period and not (grain == "yearly" and period == str(current.year)):
        raise HTTPException(status_code=422, detail="The selected time period is not available.")
    labels = {
        "dsg": "DSG",
        "sfh": "SFH",
        "amazon": "Amazon",
        "direct": "Direct Sales",
    }
    available = {
        key: value
        for key, value in channel_metrics.items()
        if value["records"] > 0
    }
    if channel != "all" and channel not in available:
        raise HTTPException(status_code=404, detail="The selected channel has no KPI data.")

    period_metrics = {
        key: _for_period(metrics, grain, period, year)
        for key, metrics in available.items()
    }
    if comparison_grain and comparison_period:
        if comparison_grain not in {"monthly", "quarterly", "yearly"}:
            raise HTTPException(status_code=422, detail="Invalid comparison time grain.")
        comparison_target_year = comparison_year or current.year
        if comparison_grain == "monthly":
            previous_months = {int(value) for value in comparison_period.split(",")}
            previous_year = comparison_target_year
            previous_label = ", ".join(
                datetime(2000, month, 1).strftime("%b")
                for month in sorted(previous_months)
            )
        elif comparison_grain == "quarterly":
            first_month = (int(comparison_period) - 1) * 3 + 1
            previous_year, previous_months = comparison_target_year, {first_month, first_month + 1, first_month + 2}
            previous_label = f"Q{comparison_period}"
        else:
            previous_year, previous_months = int(comparison_period), set(range(1, 13))
            previous_label = comparison_period
    else:
        previous_year, previous_months, previous_label = _previous_period(grain, period)
    previous_metrics = _empty_metrics()
    previous_has_data = False
    if channel == "all":
        for metrics in available.values():
            channel_previous, channel_has_data = _for_exact_months(
                metrics, previous_year, previous_months
            )
            previous_has_data = previous_has_data or channel_has_data
            for month, values in channel_previous["monthly"].items():
                _merge_month(previous_metrics, month, values)
    else:
        previous_metrics, previous_has_data = _for_exact_months(
            available[channel], previous_year, previous_months
        )
    if channel == "all":
        selected = _empty_metrics()
        for metrics in period_metrics.values():
            for month, values in metrics["monthly"].items():
                _merge_month(selected, month, values)
    else:
        selected = period_metrics[channel]

    def performance_period(
        selected_grain: str,
        selected_period: str,
        selected_year: int,
    ) -> tuple[dict[str, float], int]:
        if selected_grain == "monthly":
            months = {int(value) for value in selected_period.split(",")}
        elif selected_grain == "quarterly":
            first_month = (int(selected_period) - 1) * 3 + 1
            months = {first_month, first_month + 1, first_month + 2}
        else:
            # Yearly category performance is fiscal YTD. The existing Year
            # selector has no month input, so the server's current month is
            # the YTD cutoff for both the selected and comparison year.
            cutoff = current.month
            months = set(range(4, cutoff + 1)) if cutoff >= 4 else set(range(1, cutoff + 1))
        combined = _empty_metrics()
        sources = available.values() if channel == "all" else (available[channel],)
        for source in sources:
            period_values, _ = _for_exact_months(source, selected_year, months)
            for month, values in period_values["monthly"].items():
                _merge_month(combined, month, values)
            if selected_grain == "yearly" and current.month < 4:
                prior_values, _ = _for_exact_months(
                    source, selected_year - 1, set(range(4, 13))
                )
                for month, values in prior_values["monthly"].items():
                    _merge_month(combined, month, values)
        plan_months = len(months) + (9 if selected_grain == "yearly" and current.month < 4 else 0)
        return _category_actuals(combined), plan_months

    primary_year = int(period) if grain == "yearly" else (year or current.year)
    primary_actuals, primary_plan_months = performance_period(
        grain, period, primary_year
    )
    if comparison_grain and comparison_period:
        table_comparison_grain = comparison_grain
        table_comparison_period = comparison_period
        table_comparison_year = (
            int(comparison_period)
            if comparison_grain == "yearly"
            else (comparison_year or current.year)
        )
    else:
        table_comparison_grain = grain
        if grain == "monthly":
            table_comparison_period = str(next(iter(previous_months)))
        elif grain == "quarterly":
            table_comparison_period = previous_label.removeprefix("Q")
        else:
            table_comparison_period = str(previous_year)
        table_comparison_year = previous_year
    comparison_actuals, comparison_plan_months = performance_period(
        table_comparison_grain,
        table_comparison_period,
        table_comparison_year,
    )

    category_performance = []
    for category, label in (
        ("Books", "Books"),
        ("Web Version", "Web / E-Books"),
        ("Audio Device", "Audio Device"),
        ("Pen Drive", "Pen Drives"),
    ):
        current_plan = CATEGORY_MONTHLY_PLANS[category] * primary_plan_months
        comparison_plan = CATEGORY_MONTHLY_PLANS[category] * comparison_plan_months
        category_performance.append(
            {
                "category": label,
                "current": {"plan": current_plan, "actual": _rounded(primary_actuals[category])},
                "comparison": {"plan": comparison_plan, "actual": _rounded(comparison_actuals[category])},
            }
        )
    product_performance = _product_rankings(
        channel,
        grain,
        period,
        primary_year,
    )
    customer_performance = _customer_performance(
        channel,
        grain,
        period,
        primary_year,
    )
    customer_performance.update(_customer_mix_context(channel, grain, period, primary_year))
    state_performance, state_order_details = _state_performance(
        channel, grain, period, primary_year, include_details=True
    )
    direct_sales_performance = {
        "current": _direct_sales_classification(grain, period, primary_year),
        "comparison": _direct_sales_classification(
            table_comparison_grain,
            table_comparison_period,
            table_comparison_year,
        ),
    }
    digital_channels = (
        ("dsg", "sfh", "amazon")
        if channel == "all"
        else (channel,)
        if channel in {"dsg", "sfh", "amazon"}
        else ()
    )
    digital_current = sum(
        _period_pnl(channel_metrics[channel_id], grain, period, primary_year)
        for channel_id in digital_channels
    )
    digital_comparison = sum(
        _period_pnl(
            channel_metrics[channel_id],
            table_comparison_grain,
            table_comparison_period,
            table_comparison_year,
        )
        for channel_id in digital_channels
    )
    if channel not in {"all", "direct"}:
        direct_sales_performance = {
            "current": {
                "Direct Sales": 0.0,
                "Stall Sales": 0.0,
                "Bulk Sales": 0.0,
                "Language Lab": 0.0,
                "Total Direct Sales": 0.0,
            },
            "comparison": {
                "Direct Sales": 0.0,
                "Stall Sales": 0.0,
                "Bulk Sales": 0.0,
                "Language Lab": 0.0,
                "Total Direct Sales": 0.0,
            },
        }

    def channel_wise_values(
        digital: float, direct_values: dict[str, float]
    ) -> dict[str, float]:
        values = {
            "Digital Online": _rounded(digital),
            "Stall Sales": direct_values["Stall Sales"],
            "Direct Sales": direct_values["Direct Sales"],
            "Bulk Sales": direct_values["Bulk Sales"],
            "Language Lab": direct_values["Language Lab"],
            "OTT": 0.0,
        }
        values["Total Sales"] = _rounded(
            values["Digital Online"]
            + values["Stall Sales"]
            + values["Direct Sales"]
            + values["Bulk Sales"]
        )
        values["Grand Total Sales"] = _rounded(
            values["Total Sales"] + values["Language Lab"] + values["OTT"]
        )
        return values

    channel_wise_performance = {
        "current": channel_wise_values(
            digital_current, direct_sales_performance["current"]
        ),
        "comparison": channel_wise_values(
            digital_comparison, direct_sales_performance["comparison"]
        ),
    }

    def breakdown(metric: str) -> list[dict[str, object]]:
        if channel == "all":
            return [
                {"label": labels[key], "value": _rounded(metrics[metric])}
                for key, metrics in period_metrics.items()
            ]
        if metric == "pnl":
            category_labels = (
                ("Books", "Books"),
                ("Web Version", "Web / E-Books"),
                ("Audio Device", "Audio Device"),
                ("Pen Drive", "Pen Drives"),
            )
            category_values = {
                category: (
                    selected["zero_categories"][category]
                    + selected["taxable_categories"][category]
                    + (selected["exempted"] if category == "Books" else 0.0)
                )
                for category, _ in category_labels
            }
            if abs(sum(category_values.values()) - selected["pnl"]) > 0.01:
                raise HTTPException(
                    status_code=500,
                    detail=(
                        "The selected channel contains Total Sales amounts "
                        "without a complete product-category mapping."
                    ),
                )
            return [
                {"label": label, "value": _rounded(category_values[category])}
                for category, label in category_labels
            ]
        if metric == "zero_rated":
            return [
                {"label": category, "value": _rounded(selected["zero_categories"][category])}
                for category in (
                    *CATEGORY_ORDER,
                    *sorted(
                        category
                        for category in selected["zero_categories"]
                        if category not in CATEGORY_ORDER
                    ),
                )
                if selected["zero_categories"][category] != 0
            ]
        if metric == "exempted":
            value = selected["exempted"]
            return [{"label": "Books", "value": _rounded(value)}] if value else []
        if metric == "taxable":
            return [
                {"label": category, "value": _rounded(selected["taxable_categories"][category])}
                for category in CATEGORY_ORDER[:3]
                if selected["taxable_categories"][category] != 0
            ]
        return []

    card_definitions = (
        ("pnl", "Total Sales", "Foreign Sales + Books Sales + Taxable Sales"),
        ("exempted", "Books Sales", "Books without tax"),
        ("taxable", "Taxable Sales", "Web Version, Audio Device and Pen Drive sales"),
        ("zero_rated", "Foreign Sales", "Sales outside India"),
        ("orders", "Total Orders", "Unique valid orders"),
    )
    language_lab_monthly = _language_lab_monthly()
    trend_channels = tuple(channel_metrics) if channel == "all" else (channel,)
    # Always expose the complete calendar year. The client can then switch
    # between month, quarter, and year without fetching or changing the source.
    trend_months = [f"{primary_year}-{month:02d}" for month in range(1, 13)]
    sales_trend = {"monthly_points": []}
    for month_key in trend_months:
        trend_breakdown = {}
        for channel_key in trend_channels:
            # Trend rendering must be read-only. Accessing a missing key on the
            # defaultdict would insert empty months into the shared KPI metrics.
            month_values = channel_metrics[channel_key]["monthly"].get(month_key)
            value = float(month_values["pnl"]) if month_values is not None else 0.0
            if channel_key == "direct":
                value += language_lab_monthly.get(month_key, 0.0)
            trend_breakdown[labels[channel_key]] = _rounded(value)
        row_year, row_month = (int(value) for value in month_key.split("-"))
        sales_trend["monthly_points"].append({
            "key": month_key,
            "label": datetime(row_year, row_month, 1).strftime("%b %Y"),
            "value": _rounded(sum(trend_breakdown.values())),
            "breakdown": trend_breakdown,
        })
    order_channel_keys = {
        "dsg": "DSG", "sfh": "SFH", "amazon": "Amazon", "direct": "Direct Sales",
    }
    order_channel_labels = {
        "DSG": "DSG", "SFH": "SFH",
        "Amazon": "Amazon", "Direct Sales": "Direct Sales",
    }
    current_order_counts = _period_order_counts(grain, period, primary_year)
    comparison_order_counts = _period_order_counts(
        table_comparison_grain, table_comparison_period, table_comparison_year
    )
    visible_order_channels = (
        tuple(order_channel_keys.values())
        if channel == "all" else (order_channel_keys[channel],)
    )
    current_order_total = sum(current_order_counts[name] for name in visible_order_channels)
    comparison_order_total = sum(comparison_order_counts[name] for name in visible_order_channels)
    return {
        "selected_channel": channel,
        "selected_grain": grain,
        "selected_period": period,
        "selected_year": primary_year,
        "available_years": available_years,
        "category_performance": category_performance,
        "product_performance": product_performance,
        "customer_performance": customer_performance,
        "state_performance": state_performance,
        "state_order_details": state_order_details,
        "direct_sales_performance": direct_sales_performance,
        "channel_wise_performance": channel_wise_performance,
        "sales_trend": sales_trend,
        "filters": [
            {"id": "all", "label": "All Channels"},
            *[
                {"id": key, "label": labels[key]}
                for key in available
            ],
        ],
        "cards": [
            {
                "id": metric,
                "title": title,
                "subtitle": subtitle,
                "total": (
                    current_order_total
                    if metric == "orders" else _rounded(selected[metric])
                ),
                "breakdown": (
                    [
                        {"label": order_channel_labels[name], "value": current_order_counts[name]}
                        for name in visible_order_channels
                    ]
                    if metric == "orders" else breakdown(metric)
                ),
                "trend": [] if metric == "orders" else _trend(selected, metric, grain),
                **(
                    {
                        "previous_total": _rounded(previous_metrics[metric]),
                        "previous_period_label": previous_label,
                        "previous_has_data": previous_has_data,
                    }
                    if metric in {"zero_rated", "exempted", "taxable", "pnl"} else (
                        {
                            "previous_total": comparison_order_total,
                            "previous_period_label": previous_label,
                            "previous_has_data": comparison_order_total > 0,
                        }
                        if metric == "orders" else {}
                    )
                ),
            }
            for metric, title, subtitle in card_definitions
        ],
    }


@router.get("/kpis")
def dashboard_kpis(
    channel: str = "all",
    grain: str = "monthly",
    period: str | None = None,
    year: int | None = None,
    latest: bool = False,
    comparison_grain: str | None = None,
    comparison_period: str | None = None,
    comparison_year: int | None = None,
) -> dict[str, object]:
    """Return cached visual data unless filters or uploaded datasets changed."""
    cache_key = (
        _dashboard_data_version(), channel, grain, period, year, latest,
        comparison_grain, comparison_period, comparison_year,
    )
    now = monotonic()
    with _dashboard_cache_lock:
        cached = _dashboard_response_cache.get(cache_key)
        if cached and now - cached[0] < DASHBOARD_CACHE_TTL_SECONDS:
            return cached[1]

    # Refresh the shared source once before all visual builders run. Cached-row
    # access after this point is purely in-memory and performs no version query.
    _dashboard_source_snapshot()
    result = _build_dashboard_kpis(
        channel=channel,
        grain=grain,
        period=period,
        year=year,
        latest=latest,
        comparison_grain=comparison_grain,
        comparison_period=comparison_period,
        comparison_year=comparison_year,
    )
    with _dashboard_cache_lock:
        current_version = cache_key[0]
        expired_keys = [
            key for key, (stored_at, _) in _dashboard_response_cache.items()
            if key[0] != current_version or now - stored_at >= DASHBOARD_CACHE_TTL_SECONDS
        ]
        for key in expired_keys:
            _dashboard_response_cache.pop(key, None)
        if len(_dashboard_response_cache) >= 32:
            oldest_key = min(_dashboard_response_cache, key=lambda key: _dashboard_response_cache[key][0])
            _dashboard_response_cache.pop(oldest_key, None)
        _dashboard_response_cache[cache_key] = (monotonic(), result)
    return result
