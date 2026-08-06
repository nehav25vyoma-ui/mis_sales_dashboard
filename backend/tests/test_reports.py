from types import SimpleNamespace

import pytest

from app.reports import (
    INDIAN_LAKH_FORMAT,
    INDIAN_WHOLE_NUMBER_FORMAT,
    _append_channel_sheet,
    _build_direct_sales_overview,
    _product_performance_workbook,
    _product_type,
    _summary_workbook,
)
from app.database.models import DirectSalesDatasetRow, UploadHistory
from openpyxl import Workbook


def _row(category: str | None):
    return SimpleNamespace(category=category, row_data={"Category": category})


def test_product_type_uses_channel_category_rules():
    assert _product_type("DSG", _row("Books")) == "Books"
    assert _product_type("SFH", _row("Web Version")) == "Web Version"
    assert _product_type("Direct Sales", _row("Audio Device")) == "Audio Device"


def test_product_report_has_type_column_and_indian_number_format():
    workbook = _product_performance_workbook([])
    sheet = workbook["DSG"]

    assert [cell.value for cell in sheet[1]] == [
        "Year", "Month", "Channel", "Type", "Product", "Orders",
        "Quantity", "Without Tax Total",
    ]
    assert sheet.cell(2, 8).number_format != "General"


def test_product_report_grand_total_updates_with_excel_filters():
    row = SimpleNamespace(
        product_name="Spoken English",
        course=None,
        category="Books",
        order_number="DSG-1",
        amount="1234567",
        row_data={"Quantity": 2},
    )
    workbook = _product_performance_workbook([("DSG", row, "2026-08")])
    sheet = workbook["DSG"]

    assert sheet.auto_filter.ref == "A1:H2"
    assert sheet.cell(3, 5).value == "Grand Total"
    assert sheet.cell(3, 6).value == "=SUBTOTAL(109,F2:F2)"
    assert sheet.cell(3, 7).value == "=SUBTOTAL(109,G2:G2)"
    assert sheet.cell(3, 8).value == "=SUBTOTAL(109,H2:H2)"
    assert sheet.cell(2, 8).number_format == INDIAN_LAKH_FORMAT
    assert sheet.cell(3, 8).number_format == INDIAN_WHOLE_NUMBER_FORMAT


def test_summary_displayed_pnl_equals_displayed_sales_buckets(monkeypatch):
    metrics = {
        "dsg": {"zero_rated": 14234.77, "exempted": 36558.0, "taxable": 7515.0, "pnl": 58307.77},
        "sfh": {"zero_rated": 2314.35, "exempted": 0.0, "taxable": 8592.372881, "pnl": 10906.722881},
        "direct": {"zero_rated": 0.0, "exempted": 94244.833336, "taxable": 17816.736664, "pnl": 112061.57},
    }
    monkeypatch.setattr("app.reports._load_channel_metrics", lambda: metrics)
    monkeypatch.setattr("app.reports._for_period", lambda values, *_: values)

    sheet = _summary_workbook([], "monthly", "7", 2026)["Summary"]

    for row_number in range(3, 7):
        buckets = sum(sheet.cell(row_number, column).value for column in (3, 4, 5))
        assert sheet.cell(row_number, 6).value == buckets
        assert sheet.cell(row_number, 7).value == buckets
    assert sheet.cell(5, 6).value == 112062


def test_clean_report_total_matches_rounded_raw_aggregate():
    rows = []
    for index, amount in enumerate((0.51, 0.51), 1):
        row = SimpleNamespace(
            category="Books",
            order_number=f"DSG-{index}",
            product_name="Book",
            amount=str(amount),
            row_data={"Quantity": 1, "Country Code (Billing)": "IN"},
        )
        rows.append(("DSG", row, "2026-04"))

    workbook = Workbook()
    workbook.remove(workbook.active)
    _append_channel_sheet(workbook, "DSG", rows, "Apr - 26 DSG Sales")
    sheet = workbook["DSG"]

    # Reconcile visible whole rows so their manual sum equals the rounded raw
    # aggregate instead of independently rounding both values up to 2.
    assert sheet.cell(3, 6).value == 0
    assert sheet.cell(4, 6).value == 1
    assert sheet.cell(sheet.max_row, 6).value == "=SUBTOTAL(109,F3:F4)"
    assert sheet.auto_filter.ref == "A2:G4"


class _RowsQuery:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows


class _OverviewDatabase:
    def __init__(self, direct_rows, uploads):
        self.direct_rows = direct_rows
        self.uploads = uploads

    def query(self, model):
        return _RowsQuery(self.uploads if model is UploadHistory else self.direct_rows)


def _direct_row(row_id, order, product, amount, quantity, notes=""):
    return SimpleNamespace(
        id=row_id,
        upload_id="upload-1",
        order_number=order,
        product_name=product,
        category="Books",
        amount=str(amount),
        row_data={
            "Issue Date": "2026-04-10",
            "Without Tax Total": amount,
            "Mapped Quantity": quantity,
            "Category Quantity": quantity,
            "Private Notes": notes,
        },
    )


def test_direct_sales_overview_reuses_dashboard_mapping_and_reconciles():
    database = _OverviewDatabase(
        [
            _direct_row(1, "A", "Bulk Book", 100.4, 11),
            _direct_row(2, "B", "Retail Book", 50.4, 2),
            _direct_row(3, "C", "Stall Book", 25.4, 20, "Stall counter"),
        ],
        [SimpleNamespace(upload_id="upload-1", uploaded_at=None)],
    )
    result = _build_direct_sales_overview(
        database,
        years={2026},
        months={4},
        types={"Bulk", "Retail", "Stall"},
        products=set(),
    )

    assert result["validated"] is True
    assert result["totals"] == {"Bulk": 101, "Retail": 50, "Stall": 25, "Language Lab": 0}
    assert result["overall_total"] == 176
    assert {row["type"] for row in result["rows"]} == {"Bulk", "Retail", "Stall"}


def test_direct_sales_overview_reconciles_type_totals_to_overall_total():
    rows = [
        _direct_row(1, "B-1", "Bulk item", 4186.9, 11),
        _direct_row(2, "R-1", "Retail item", 69699.3, 1),
        _direct_row(3, "S-1", "Stall item", 38175.37, 1, "STALL"),
    ]
    database = _OverviewDatabase(
        rows,
        [SimpleNamespace(upload_id="upload-1", uploaded_at=None)],
    )

    result = _build_direct_sales_overview(
        database,
        years={2026}, months={4}, types={"Bulk", "Retail", "Stall"}, products=set(),
    )

    assert result["overall_total"] == 112062
    assert sum(result["totals"].values()) == 112062


def test_direct_sales_overview_separates_language_lab_from_retail():
    database = _OverviewDatabase(
        [_direct_row(1, "L-1", "Language Lab", 48813.57, 1, "Language Lab")],
        [SimpleNamespace(upload_id="upload-1", uploaded_at=None)],
    )

    result = _build_direct_sales_overview(
        database,
        years={2026}, months={4}, types={"Language Lab"}, products=set(),
    )

    assert result["totals"]["Language Lab"] == 48814
    assert result["totals"]["Retail"] == 0
    assert result["overall_total"] == 48814


def test_direct_sales_overview_rejects_duplicate_source_rows():
    row = _direct_row(1, "A", "Book", 100, 1)
    database = _OverviewDatabase(
        [row, row],
        [SimpleNamespace(upload_id="upload-1", uploaded_at=None)],
    )
    with pytest.raises(Exception, match="Duplicate Direct Sales database row"):
        _build_direct_sales_overview(
            database,
            years={2026}, months={4}, types={"Retail"}, products=set(),
        )
