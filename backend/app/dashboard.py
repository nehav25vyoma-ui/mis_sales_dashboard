from collections import defaultdict
from datetime import datetime
from typing import Any

import pandas as pd
from fastapi import APIRouter, HTTPException

from app.database.database import SessionLocal
from app.database.models import DirectSalesDatasetRow, DSGDatasetRow, SFHDatasetRow, UploadHistory
from app.calculations.amounts import sfh_amount_from_record, sfh_is_inr_currency

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

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
    "CT": "Chhattisgarh", "DL": "Delhi", "GA": "Goa", "GJ": "Gujarat",
    "HR": "Haryana", "HP": "Himachal Pradesh", "JK": "Jammu and Kashmir",
    "JH": "Jharkhand", "KA": "Karnataka", "KL": "Kerala", "LA": "Ladakh",
    "LD": "Lakshadweep", "MP": "Madhya Pradesh", "MH": "Maharashtra",
    "MN": "Manipur", "ML": "Meghalaya", "MZ": "Mizoram", "NL": "Nagaland",
    "OD": "Odisha", "OR": "Odisha", "PY": "Puducherry", "PB": "Punjab",
    "RJ": "Rajasthan", "SK": "Sikkim", "TN": "Tamil Nadu", "TS": "Telangana",
    "TG": "Telangana", "TR": "Tripura", "UP": "Uttar Pradesh",
    "UK": "Uttarakhand", "UT": "Uttarakhand", "WB": "West Bengal",
}
DATE_ALIASES = (
    "order date",
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


def _number(value: object) -> float:
    if value is None:
        return 0.0
    try:
        return float(str(value).replace(",", "").replace("₹", "").strip())
    except (TypeError, ValueError):
        return 0.0


def _direct_amount(row: DirectSalesDatasetRow) -> float:
    # row_data is authoritative so uploads saved before the dedicated Direct
    # Sales amount mapping also use the correct net-of-tax business value.
    value = _row_value(row.row_data, ("without tax total",))
    return _number(value if value is not None else row.amount)
    try:
        return float(str(value).replace(",", "").replace("₹", "").strip())
    except (TypeError, ValueError):
        return 0.0


def _month(data: dict[str, Any], fallback: datetime) -> str:
    value = _row_value(data, DATE_ALIASES)
    if value is not None:
        parsed = pd.to_datetime(value, errors="coerce")
        if not pd.isna(parsed):
            return parsed.strftime("%Y-%m")
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
    channels = {
        "dsg": _empty_metrics(),
        "sfh": _empty_metrics(),
        "direct": _empty_metrics(),
    }
    with SessionLocal() as database:
        upload_dates = {
            item.upload_id: item.uploaded_at
            for item in database.query(UploadHistory).all()
        }
        for row in database.query(DSGDatasetRow).all():
            uploaded_at = upload_dates.get(row.upload_id, datetime.now())
            country_code = _row_value(row.row_data, ("country code (billing)",))
            _add_row(
                channels["dsg"],
                category=row.category or "",
                amount=_number(row.amount),
                is_foreign=str(country_code).strip().upper() != "IN",
                month=_month(row.row_data, uploaded_at),
            )
        for row in database.query(SFHDatasetRow).all():
            uploaded_at = upload_dates.get(row.upload_id, datetime.now())
            currency = _row_value(row.row_data, ("currency",))
            _add_row(
                channels["sfh"],
                category=row.category or "Web Version",
                amount=_number(sfh_amount_from_record(row.row_data)),
                is_foreign=not sfh_is_inr_currency(currency),
                month=_month(row.row_data, uploaded_at),
            )
        for row in database.query(DirectSalesDatasetRow).all():
            uploaded_at = upload_dates.get(row.upload_id, datetime.now())
            _add_row(
                channels["direct"],
                category=row.category or "",
                amount=_direct_amount(row),
                # Direct Sales is always domestic for MIS tax reporting.
                is_foreign=False,
                month=_month(row.row_data, uploaded_at),
            )
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

    totals = {"Direct Sales": 0.0, "Stall Sales": 0.0, "Bulk Sales": 0.0}
    with SessionLocal() as database:
        upload_dates = {
            item.upload_id: item.uploaded_at
            for item in database.query(UploadHistory).all()
        }
        for row in database.query(DirectSalesDatasetRow).all():
            month = _month(row.row_data, upload_dates.get(row.upload_id, current))
            if not included(month):
                continue
            classification = str(
                _row_value(row.row_data, ("sales classification",))
                or (
                    "Stall Sales"
                    if "stall" in str(
                        _row_value(row.row_data, ("private notes",)) or ""
                    ).casefold()
                    else "Bulk Sales"
                    if _number(_row_value(row.row_data, ("mapped quantity",))) > 10
                    else "Direct Sales"
                )
            )
            if classification not in totals:
                classification = "Direct Sales"
            totals[classification] += _direct_amount(row)
    totals["Total Direct Sales"] = sum(totals.values())
    return {key: _rounded(value) for key, value in totals.items()}


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
        "direct": defaultdict(float),
    }
    labels: dict[str, dict[str, str]] = {"dsg": {}, "sfh": {}, "direct": {}}
    with SessionLocal() as database:
        upload_dates = {
            item.upload_id: item.uploaded_at
            for item in database.query(UploadHistory).all()
        }
        if channel in {"all", "dsg"}:
            for row in database.query(DSGDatasetRow).all():
                month = _month(
                    row.row_data,
                    upload_dates.get(row.upload_id, current),
                )
                product = str(row.product_name or "").strip()
                if product and included(month):
                    key = product.casefold()
                    labels["dsg"].setdefault(key, product)
                    totals["dsg"][key] += _number(row.amount)
        if channel in {"all", "sfh"}:
            for row in database.query(SFHDatasetRow).all():
                month = _month(
                    row.row_data,
                    upload_dates.get(row.upload_id, current),
                )
                course = str(row.course or row.product_name or "").strip()
                if course and included(month):
                    key = course.casefold()
                    labels["sfh"].setdefault(key, course)
                    totals["sfh"][key] += _number(sfh_amount_from_record(row.row_data))
        if channel in {"all", "direct"}:
            for row in database.query(DirectSalesDatasetRow).all():
                month = _month(row.row_data, upload_dates.get(row.upload_id, current))
                product = str(row.product_name or "").strip()
                if product and included(month):
                    key = product.casefold()
                    labels["direct"].setdefault(key, product)
                    totals["direct"][key] += _direct_amount(row)

    channel_labels = {
        "dsg": ("Online Sales (DSG)", "Products"),
        "sfh": ("Website Sales (SFH)", "Courses"),
        "direct": ("Direct Sales", "Products"),
    }
    requested_channels = ("dsg", "sfh", "direct") if channel == "all" else (channel,)
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
    return {"channels": sections}


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
    with SessionLocal() as database:
        upload_dates = {
            item.upload_id: item.uploaded_at
            for item in database.query(UploadHistory).all()
        }
        if channel in {"all", "dsg"}:
            for row in database.query(DSGDatasetRow).all():
                month = _month(row.row_data, upload_dates.get(row.upload_id, current))
                email = str(_row_value(row.row_data, ("email (billing)",)) or "").strip().casefold()
                if email and included(month):
                    email_counts[email] += 1
        if channel in {"all", "sfh"}:
            for row in database.query(SFHDatasetRow).all():
                month = _month(row.row_data, upload_dates.get(row.upload_id, current))
                email = str(_row_value(row.row_data, ("email",)) or "").strip().casefold()
                if email and included(month):
                    email_counts[email] += 1
        if channel in {"all", "direct"}:
            for row in database.query(DirectSalesDatasetRow).all():
                month = _month(row.row_data, upload_dates.get(row.upload_id, current))
                email = str(
                    _row_value(row.row_data, ("email", "customer email", "email (billing)")) or ""
                ).strip().casefold()
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


def _state_performance(channel: str, grain: str, period: str, selected_year: int) -> list[dict[str, object]]:
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
    current = datetime.now()
    with SessionLocal() as database:
        upload_dates = {item.upload_id: item.uploaded_at for item in database.query(UploadHistory).all()}
        sources = []
        if channel in {"all", "dsg"}:
            sources.append(("dsg", database.query(DSGDatasetRow).all()))
        if channel in {"all", "sfh"}:
            sources.append(("sfh", database.query(SFHDatasetRow).all()))
        if channel in {"all", "direct"}:
            sources.append(("direct", database.query(DirectSalesDatasetRow).all()))
        for source, source_rows in sources:
            for row in source_rows:
                if not included(_month(row.row_data, upload_dates.get(row.upload_id, current))):
                    continue
                if source == "dsg":
                    code = str(_row_value(row.row_data, ("state code (billing)",)) or "").strip().upper()
                    state = INDIAN_STATE_NAMES.get(code, code)
                    amount = _number(row.amount)
                elif source == "sfh":
                    state = str(_row_value(row.row_data, ("place of supply",)) or "").strip().title()
                    amount = _number(sfh_amount_from_record(row.row_data))
                else:
                    state = str(_row_value(row.row_data, ("client state",)) or "").strip().title()
                    amount = _direct_amount(row)
                totals[state or "NA"] += amount
    return [
        {"state": state, "amount": _rounded(amount)}
        for state, amount in sorted(totals.items(), key=lambda item: (-item[1], item[0].casefold()))
    ]


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


@router.get("/kpis")
def dashboard_kpis(
    channel: str = "all",
    grain: str = "monthly",
    period: str | None = None,
    year: int | None = None,
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
        "dsg": "Online Sales (DSG)",
        "sfh": "Website Sales (SFH)",
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
    state_performance = _state_performance(channel, grain, period, primary_year)
    direct_sales_performance = {
        "current": _direct_sales_classification(grain, period, primary_year),
        "comparison": _direct_sales_classification(
            table_comparison_grain,
            table_comparison_period,
            table_comparison_year,
        ),
    }
    digital_channels = (
        ("dsg", "sfh")
        if channel == "all"
        else (channel,)
        if channel in {"dsg", "sfh"}
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
                "Total Direct Sales": 0.0,
            },
            "comparison": {
                "Direct Sales": 0.0,
                "Stall Sales": 0.0,
                "Bulk Sales": 0.0,
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
            "Language Lab": 0.0,
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
                        "The selected channel contains Sales as per P&L amounts "
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
        ("zero_rated", "0 Rated Sales", "Non-INR Foreign Sales"),
        ("exempted", "Exempted Sales", "No tax applied"),
        ("taxable", "Taxable Amount", "Audio Device, Pen Drive, Web Version"),
        ("pnl", "Sales as per P&L", "0 Rated + Exempted + Taxable"),
    )
    if channel == "all":
        sales_trend = {
            "mode": "channel",
            "points": [
                {"label": labels[key], "value": _rounded(period_metrics[key]["pnl"])}
                for key in ("dsg", "sfh", "direct")
                if key in period_metrics
            ],
        }
    else:
        month_points = []
        for month_key, values in sorted(available[channel]["monthly"].items()):
            row_year, row_month = (int(value) for value in month_key.split("-"))
            if row_year == primary_year:
                month_points.append({
                    "label": datetime(row_year, row_month, 1).strftime("%b %Y"),
                    "value": _rounded(values["pnl"]),
                })
        sales_trend = {"mode": "month", "points": month_points}
    return {
        "selected_channel": channel,
        "selected_grain": grain,
        "selected_period": period,
        "available_years": available_years,
        "category_performance": category_performance,
        "product_performance": product_performance,
        "customer_performance": customer_performance,
        "state_performance": state_performance,
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
                "total": _rounded(selected[metric]),
                "breakdown": breakdown(metric),
                "trend": _trend(selected, metric, grain),
                **(
                    {
                        "previous_total": _rounded(previous_metrics[metric]),
                        "previous_period_label": previous_label,
                        "previous_has_data": previous_has_data,
                    }
                    if metric in {"zero_rated", "exempted", "taxable", "pnl"} else {}
                ),
            }
            for metric, title, subtitle in card_definitions
        ],
    }
