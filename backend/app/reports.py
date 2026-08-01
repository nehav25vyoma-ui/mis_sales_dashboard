from collections import defaultdict
from datetime import datetime
from io import BytesIO
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from app.calculations.amounts import sfh_amount_from_record
from app.dashboard import (
    _direct_amount,
    _for_period,
    _load_channel_metrics,
    _month,
    _number,
    _row_value,
)
from app.database.database import SessionLocal
from app.database.models import DirectSalesDatasetRow, DSGDatasetRow, SFHDatasetRow, UploadHistory

router = APIRouter(prefix="/api/reports", tags=["reports"])

CHANNELS = (
    ("DSG", DSGDatasetRow),
    ("SFH", SFHDatasetRow),
    ("Direct Sales", DirectSalesDatasetRow),
)
REPORT_TYPES = {"summary", "channel", "category", "product"}
HEADER_FILL = PatternFill("solid", fgColor="17213A")
TITLE_FILL = PatternFill("solid", fgColor="5B5CE2")
INDIAN_STATE_NAMES = {
    "AN": "Andaman and Nicobar Islands", "AP": "Andhra Pradesh",
    "AR": "Arunachal Pradesh", "AS": "Assam", "BR": "Bihar",
    "CH": "Chandigarh", "CG": "Chhattisgarh", "CT": "Chhattisgarh",
    "DN": "Dadra and Nagar Haveli and Daman and Diu",
    "DD": "Dadra and Nagar Haveli and Daman and Diu", "DL": "Delhi",
    "GA": "Goa", "GJ": "Gujarat", "HR": "Haryana",
    "HP": "Himachal Pradesh", "JK": "Jammu and Kashmir",
    "JH": "Jharkhand", "KA": "Karnataka", "KL": "Kerala",
    "LA": "Ladakh", "LD": "Lakshadweep", "MP": "Madhya Pradesh",
    "MH": "Maharashtra", "MN": "Manipur", "ML": "Meghalaya",
    "MZ": "Mizoram", "NL": "Nagaland", "OD": "Odisha", "OR": "Odisha",
    "PY": "Puducherry", "PB": "Punjab", "RJ": "Rajasthan",
    "SK": "Sikkim", "TN": "Tamil Nadu", "TS": "Telangana",
    "TG": "Telangana", "TR": "Tripura", "UP": "Uttar Pradesh",
    "UK": "Uttarakhand", "UT": "Uttarakhand", "WB": "West Bengal",
}


def _matches(month_key: str, grain: str, period: str, year: int) -> bool:
    row_year, row_month = (int(value) for value in month_key.split("-"))
    if grain == "monthly":
        selected_months = {int(value) for value in period.split(",")}
        return row_year == year and row_month in selected_months
    return row_year == year


def _period_label(grain: str, period: str, year: int) -> str:
    if grain == "monthly":
        selected = sorted({int(value) for value in period.split(",")})
        labels = [datetime(year, value, 1).strftime("%b") for value in selected]
        if len(labels) == 1:
            month_label = labels[0]
        elif len(selected) <= 3:
            month_label = ", ".join(labels)
        elif selected == list(range(selected[0], selected[-1] + 1)):
            month_label = f"{labels[0]} - {labels[-1]}"
        else:
            month_label = f"{len(selected)} Selected Months"
        return f"{month_label} - {str(year)[-2:]}"
    return str(year)


def _filtered_rows(database, grain: str, period: str, year: int):
    upload_dates = {row.upload_id: row.uploaded_at for row in database.query(UploadHistory).all()}
    fallback = datetime.now()
    result = []
    for channel, model in CHANNELS:
        for row in database.query(model).all():
            month_key = _month(row.row_data, upload_dates.get(row.upload_id, fallback))
            if _matches(month_key, grain, period, year):
                result.append((channel, row, month_key))
    return result


def _amount(channel: str, row) -> float:
    if channel == "SFH":
        return _number(sfh_amount_from_record(row.row_data))
    if channel == "Direct Sales":
        return _direct_amount(row)
    return _number(row.amount)


def _invoice_amount(row) -> float:
    value = _row_value(row.row_data, (
        "invoice amount", "total invoice amount", "order total amount", "order total",
        "actual amount", "total", "grand total", "amount",
    ))
    return _number(value if value is not None else getattr(row, "amount", None))


def _quantity(channel: str, row) -> float:
    value = _row_value(
        row.row_data,
        ("quantity", "qty", "category quantity", "mapped quantity"),
    )
    if value is not None and str(value).strip() != "":
        return _number(value)
    # SFH exports are transaction-level: one row is one purchased course.
    # Current SFH source files have Course/Description but no Quantity field.
    if channel == "SFH" and (row.product_name or getattr(row, "course", None)):
        return 1.0
    return 0.0


def _location(channel: str, data: dict) -> str:
    if channel == "DSG":
        value = _row_value(data, ("state code (billing)",))
        code = str(value or "").strip().upper()
        return INDIAN_STATE_NAMES.get(code, str(value or "").strip())
    if channel == "SFH":
        return str(_row_value(data, ("place of supply",)) or "").strip()
    if channel == "Direct Sales":
        return str(_row_value(data, ("client state",)) or "").strip()
    return ""


def _with_tax_amount(channel: str, row) -> float:
    aliases = {
        "DSG": ("order total amount",),
        "SFH": ("earnings",),
        "Direct Sales": ("total",),
    }
    return _number(_row_value(row.row_data, aliases[channel]))


def _order_identifier(channel: str, row) -> str:
    if channel == "SFH":
        value = _row_value(row.row_data, ("invoice no.", "receipt no.", "reg. no."))
    else:
        value = getattr(row, "order_number", None) or _row_value(
            row.row_data, ("order number", "invoice number")
        )
    text = str(value or "").strip().casefold()
    return text


def _style_sheet(sheet, title: str | None = None) -> None:
    sheet.freeze_panes = "A3" if title else "A2"
    header_row = 2 if title else 1
    if title:
        sheet.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max(sheet.max_column, 1))
        cell = sheet.cell(1, 1)
        cell.value = title
        cell.font = Font(color="FFFFFF", bold=True, size=14)
        cell.fill = TITLE_FILL
        cell.alignment = Alignment(horizontal="center")
    for cell in sheet[header_row]:
        cell.font = Font(color="FFFFFF", bold=True)
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center")
    sheet.auto_filter.ref = f"A{header_row}:{sheet.cell(sheet.max_row, sheet.max_column).coordinate}"
    for column_index, column in enumerate(sheet.columns, 1):
        values = [str(cell.value or "") for cell in column]
        sheet.column_dimensions[get_column_letter(column_index)].width = min(max(map(len, values)) + 3, 45)


def _append_channel_sheet(workbook: Workbook, name: str, rows, label: str) -> None:
    sheet = workbook.create_sheet(name)
    sheet.append([label])
    sheet.append(["Sl.No", "Type", "ID", "Description", "Quantity", "Total", "Location"])
    total_quantity = 0.0
    total_amount = 0.0
    for index, (_, row, _) in enumerate(rows, 1):
        data = row.row_data
        quantity = _quantity(name, row)
        amount = _amount(name, row)
        display_quantity = round(quantity)
        display_amount = round(amount)
        total_quantity += display_quantity
        total_amount += display_amount
        sheet.append([
            index,
            row.category or _row_value(data, ("type", "sales type")) or "",
            getattr(row, "order_number", None) or _row_value(data, ("id", "order id", "invoice number")) or "",
            row.product_name or getattr(row, "course", None) or "",
            display_quantity,
            display_amount,
            _location(name, data) or "NA",
        ])
    sheet.append(["", "Grand Total", "", "", round(total_quantity), round(total_amount), ""])
    _style_sheet(sheet, label)
    for cell in sheet["F"][2:]:
        cell.number_format = '#,##0'
    for cell in sheet[sheet.max_row]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="E8EAF6")
        cell.border = Border(bottom=Side(style="thin", color="1F2937"))


def _summary_workbook(rows, grain: str, period: str, year: int) -> Workbook:
    workbook = Workbook()
    workbook.remove(workbook.active)
    label = _period_label(grain, period, year)
    metrics = _load_channel_metrics()
    summary = workbook.create_sheet("Summary")
    summary.append([f"{label} Sales"])
    summary.append([
        "Sl.no",
        "Particulars",
        "0 Rated Sales",
        "Exempted Sales",
        "Taxable Amount",
        "Sales As per P&L",
        "Total Invoice Amount",
    ])
    channel_definitions = (
        ("DSG", "dsg", "Online Sales"),
        ("SFH", "sfh", "Website Sales"),
        ("Direct Sales", "direct", "Direct Sales"),
    )
    total_values = [0.0] * 5
    for index, (channel_name, metric_key, display_name) in enumerate(channel_definitions, 1):
        values = _for_period(metrics.get(metric_key, {}), grain, period, year) if metric_key in metrics else defaultdict(float)
        amounts = [
            values["zero_rated"],
            values["exempted"],
            values["taxable"],
            values["pnl"],
            values["pnl"],
        ]
        display_amounts = [round(amount) for amount in amounts]
        total_values = [current + amount for current, amount in zip(total_values, display_amounts)]
        summary.append([index, display_name, *display_amounts])
    summary.append(["", "Total Sales", *total_values])
    _style_sheet(summary, f"{label} Sales")
    thin = Side(style="thin", color="1F2937")
    for row in summary.iter_rows(min_row=2, max_row=summary.max_row, min_col=1, max_col=7):
        for cell in row:
            cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)
            cell.alignment = Alignment(vertical="center", wrap_text=True)
            if cell.column >= 3 and cell.row >= 3:
                cell.number_format = '#,##0;[Red]-#,##0;-'
    for cell in summary[summary.max_row]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="E8EAF6")
    summary.row_dimensions[2].height = 34
    for channel, _ in CHANNELS:
        channel_rows = [item for item in rows if item[0] == channel]
        channel_title = f"{label} {channel}" if channel == "Direct Sales" else f"{label} {channel} Sales"
        _append_channel_sheet(workbook, channel, channel_rows, channel_title)
    return workbook


def _performance_workbook(rows, report_type: str, grain: str, period: str, year: int) -> Workbook:
    if report_type == "channel":
        return _channel_performance_workbook(rows)
    if report_type == "category":
        return _category_performance_workbook(rows, grain, period, year)
    if report_type == "product":
        return _product_performance_workbook(rows)
    workbook = Workbook()
    sheet = workbook.active
    titles = {"channel": "Channel Wise Performance", "category": "Category Wise Performance", "product": "Product Wise Performance"}
    label = _period_label(grain, period, year)
    sheet.title = titles[report_type][:31]
    sheet.append([f"{label} {titles[report_type]}"])
    group_index = {"channel": 0, "category": 1, "product": 2}[report_type]
    totals = defaultdict(lambda: [0.0, 0.0])
    for channel, row, _ in rows:
        keys = (channel, row.category or "Uncategorised", row.product_name or getattr(row, "course", None) or "Unmapped")
        quantity = _quantity(channel, row)
        totals[keys[group_index]][0] += quantity
        totals[keys[group_index]][1] += _amount(channel, row)
    sheet.append(["Sl.No", titles[report_type].replace(" Wise Performance", ""), "Quantity", "Total"])
    for index, (name, values) in enumerate(sorted(totals.items()), 1):
        sheet.append([index, name, round(values[0]), round(values[1])])
    _style_sheet(sheet, f"{label} {titles[report_type]}")
    for cell in sheet["D"][2:]:
        cell.number_format = '#,##0'
    return workbook


def _product_performance_workbook(rows) -> Workbook:
    workbook = Workbook()
    workbook.remove(workbook.active)
    grouped = defaultdict(lambda: {"order_ids": set(), "quantity": 0.0, "total": 0.0})
    for channel, row, month_key in rows:
        product = str(row.product_name or getattr(row, "course", None) or "Unmapped").strip()
        key = (month_key, channel, product)
        order_id = _order_identifier(channel, row)
        if order_id:
            grouped[key]["order_ids"].add(order_id)
        grouped[key]["quantity"] += _quantity(channel, row)
        grouped[key]["total"] += _amount(channel, row)
    for channel, _ in CHANNELS:
        sheet = workbook.create_sheet(channel)
        sheet.append([
            "Year", "Month", "Channel", "Product", "Orders", "Quantity",
            "Without Tax Total",
        ])
        ordered = sorted(
            (
                (key, values)
                for key, values in grouped.items()
                if key[1] == channel
            ),
            key=lambda item: (item[0][0], item[0][2].casefold()),
        )
        display_quantities = _reconciled_whole_numbers(
            [values["quantity"] for _, values in ordered]
        )
        display_totals = _reconciled_whole_numbers(
            [values["total"] for _, values in ordered]
        )
        for ((month_key, _, product), values), quantity, total in zip(
            ordered, display_quantities, display_totals
        ):
            row_year, row_month = (int(value) for value in month_key.split("-"))
            sheet.append([
                row_year,
                datetime(row_year, row_month, 1).strftime("%b"),
                channel,
                product,
                len(values["order_ids"]),
                quantity,
                total,
            ])
        first_data_row = 2
        last_data_row = sheet.max_row
        total_orders = sum(sheet.cell(row, 5).value for row in range(first_data_row, last_data_row + 1))
        total_quantity = sum(sheet.cell(row, 6).value for row in range(first_data_row, last_data_row + 1))
        total_without_tax = sum(sheet.cell(row, 7).value for row in range(first_data_row, last_data_row + 1))
        sheet.append([
            "", "", channel, "Grand Total", total_orders, total_quantity,
            total_without_tax,
        ])
        _style_sheet(sheet)
        for row_number in range(2, sheet.max_row + 1):
            for column in (5, 6, 7):
                sheet.cell(row_number, column).number_format = '#,##0;[Red]-#,##0;-'
        for cell in sheet[sheet.max_row]:
            cell.font = Font(bold=True)
            cell.fill = PatternFill("solid", fgColor="E8EAF6")
    workbook.properties.title = "Product Wise Performance Report"
    return workbook


def _reconciled_whole_numbers(values: list[float]) -> list[int]:
    """Round detail values while preserving the rounded aggregate total."""
    displayed = [round(value) for value in values]
    difference = round(sum(values)) - sum(displayed)
    if difference == 0 or not values:
        return displayed
    errors = [value - rounded for value, rounded in zip(values, displayed)]
    direction = 1 if difference > 0 else -1
    order = sorted(
        range(len(values)),
        key=lambda index: errors[index],
        reverse=difference > 0,
    )
    for offset in range(abs(difference)):
        displayed[order[offset % len(order)]] += direction
    return displayed


def _category_performance_workbook(rows, grain: str, period: str, year: int) -> Workbook:
    workbook = Workbook()
    workbook.remove(workbook.active)
    if grain == "monthly":
        month_numbers = sorted({int(value) for value in period.split(",")})
    else:
        month_numbers = sorted({int(month_key.split("-")[1]) for _, _, month_key in rows})
    month_keys = [f"{year}-{month:02d}" for month in month_numbers]
    month_labels = [datetime(year, month, 1).strftime("%b") for month in month_numbers]
    canonical = {
        "audio device": "Audio Device",
        "books": "Books",
        "book": "Books",
        "pen drive": "Pen Drive",
        "pen drives": "Pen Drive",
        "web version": "Web Version",
        "web / e-books": "Web Version",
        "web version / e-books": "Web Version",
    }
    preferred_order = ["Audio Device", "Books", "Pen Drive", "Web Version"]
    for channel, _ in CHANNELS:
        sheet = workbook.create_sheet(channel)
        sheet.append(["Category", *month_labels, "Total Sales", "% Contribution"])
        monthly_totals = defaultdict(lambda: defaultdict(float))
        for row_channel, row, month_key in rows:
            if row_channel != channel:
                continue
            raw_category = str(row.category or "Uncategorised").strip()
            category = canonical.get(raw_category.casefold(), raw_category or "Uncategorised")
            monthly_totals[category][month_key] += _amount(channel, row)
        categories = [category for category in preferred_order if category in monthly_totals]
        categories.extend(sorted(
            (category for category in monthly_totals if category not in preferred_order),
            key=str.casefold,
        ))
        category_values = []
        for category in categories:
            values = [round(monthly_totals[category][month_key]) for month_key in month_keys]
            category_values.append((category, values, sum(values)))
        grand_total = sum(total for _, _, total in category_values)
        for category, values, total in category_values:
            contribution = total / grand_total if grand_total else 0
            sheet.append([category, *values, total, contribution])
        monthly_grand_totals = [sum(values[index] for _, values, _ in category_values) for index in range(len(month_keys))]
        sheet.append(["Total", *monthly_grand_totals, grand_total, "-"])
        _style_sheet(sheet)
        total_column = len(month_keys) + 2
        contribution_column = total_column + 1
        for row_number in range(2, sheet.max_row + 1):
            for column in range(2, total_column + 1):
                sheet.cell(row_number, column).number_format = '#,##0;[Red]-#,##0;-'
            if isinstance(sheet.cell(row_number, contribution_column).value, (int, float)):
                sheet.cell(row_number, contribution_column).number_format = '0.00%'
        for cell in sheet[sheet.max_row]:
            cell.font = Font(bold=True)
            cell.fill = PatternFill("solid", fgColor="E8EAF6")
    workbook.properties.title = "Category Wise Performance Report"
    return workbook


def _channel_performance_workbook(rows) -> Workbook:
    workbook = Workbook()
    workbook.remove(workbook.active)
    headers = [
        "Year", "Month Name", "Total Orders", "Orders Var MOM", "Orders MOM %",
        "With Tax Total", "Without Tax Total", "Sales Var MOM", "Sales MOM %",
    ]
    for channel, _ in CHANNELS:
        sheet = workbook.create_sheet(channel)
        sheet.append(headers)
        monthly = defaultdict(lambda: {"with_tax_by_order": defaultdict(set), "without_tax": 0.0})
        for row_channel, row, month_key in rows:
            if row_channel != channel:
                continue
            order_id = _order_identifier(channel, row)
            if order_id:
                monthly[month_key]["with_tax_by_order"][order_id].add(
                    _with_tax_amount(channel, row)
                )
            monthly[month_key]["without_tax"] += _amount(channel, row)
        previous = None
        for month_key in sorted(monthly):
            values = monthly[month_key]
            row_year, row_month = (int(value) for value in month_key.split("-"))
            orders = len(values["with_tax_by_order"])
            with_tax = round(
                sum(sum(order_values) for order_values in values["with_tax_by_order"].values())
            )
            without_tax = round(values["without_tax"])
            if previous is None:
                order_variance = order_percent = sales_variance = sales_percent = "-"
            else:
                order_variance = orders - previous["orders"]
                order_percent = order_variance / orders if orders else "-"
                sales_variance = without_tax - previous["without_tax"]
                sales_percent = sales_variance / without_tax if without_tax else "-"
            sheet.append([
                row_year,
                datetime(row_year, row_month, 1).strftime("%b"),
                orders,
                order_variance,
                order_percent,
                with_tax,
                without_tax,
                sales_variance,
                sales_percent,
            ])
            previous = {
                "orders": orders,
                "with_tax": with_tax,
                "without_tax": without_tax,
            }
        _style_sheet(sheet)
        for row_number in range(2, sheet.max_row + 1):
            for column in (3, 4, 6, 7, 8):
                sheet.cell(row_number, column).number_format = '#,##0;[Red]-#,##0;-'
            for column in (5, 9):
                if isinstance(sheet.cell(row_number, column).value, (int, float)):
                    sheet.cell(row_number, column).number_format = '0%;[Red]-0%;-'
    workbook.properties.title = "Channel Wise Performance Report"
    return workbook


def _raw_workbook(rows, grain: str, period: str, year: int) -> Workbook:
    workbook = Workbook()
    workbook.remove(workbook.active)
    label = _period_label(grain, period, year)
    for channel, _ in CHANNELS:
        channel_rows = [row for row_channel, row, _ in rows if row_channel == channel]
        sheet = workbook.create_sheet(channel)
        keys = list(dict.fromkeys(key for row in channel_rows for key in row.row_data))
        sheet.append(keys or ["No records"])
        for row in channel_rows:
            sheet.append([row.row_data.get(key, "") for key in keys])
        _style_sheet(sheet)
    workbook.properties.title = f"{label} filtered data set"
    return workbook


def _clean_workbook(rows, grain: str, period: str, year: int) -> Workbook:
    workbook = Workbook()
    workbook.remove(workbook.active)
    label = _period_label(grain, period, year)
    for channel, _ in CHANNELS:
        channel_rows = [item for item in rows if item[0] == channel]
        channel_title = f"{label} {channel}" if channel == "Direct Sales" else f"{label} {channel} Sales"
        _append_channel_sheet(workbook, channel, channel_rows, channel_title)
    workbook.properties.title = f"{label} cleaned sales dataset"
    return workbook


@router.get("/download")
def download_report(
    grain: str = "monthly",
    period: str | None = None,
    year: int | None = None,
    report_type: str = "summary",
    dataset: str = "report",
):
    now = datetime.now()
    year = year or now.year
    period = period or (str(now.month) if grain == "monthly" else str(year))
    if grain not in {"monthly", "yearly"} or report_type not in REPORT_TYPES or dataset not in {"report", "clean"}:
        raise HTTPException(status_code=422, detail="Invalid report filter.")
    try:
        if grain == "monthly":
            selected_months = [int(value) for value in period.split(",") if value]
            if not selected_months or any(value < 1 or value > 12 for value in selected_months):
                raise ValueError
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Invalid reporting period.") from error
    with SessionLocal() as database:
        rows = _filtered_rows(database, grain, period, year)
    workbook = _clean_workbook(rows, grain, period, year) if dataset == "clean" else (
        _summary_workbook(rows, grain, period, year)
        if report_type == "summary"
        else _performance_workbook(rows, report_type, grain, period, year)
    )
    output = BytesIO()
    workbook.save(output)
    output.seek(0)
    label = _period_label(grain, period, year).replace(" ", "-")
    filename = f"{label}-{report_type}-{dataset}.xlsx"
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )
