from contextlib import ExitStack
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app import dashboard


class LanguageLabKpiTests(TestCase):
    def test_total_sales_includes_lab_for_all_and_direct_only(self):
        metrics = {key: dashboard._empty_metrics() for key in ("dsg", "sfh", "amazon", "direct")}
        for channel, amount in (("dsg", 50), ("direct", 100)):
            dashboard._add_row(metrics[channel], category="Books", amount=amount,
                               is_foreign=False, month="2026-08")
        rows = [SimpleNamespace(category=category, amount=str(amount), upload_id=month,
                                row_data={}) for category, amount, month in (
            ("Language Lab", 25, "aug"), ("Language Lab", 10, "jul"),
            ("Language Lab", 999, "sep"), ("N/A", 500, "aug"),
        )]
        from datetime import datetime
        with ExitStack() as stack:
            mocks = {
                "_load_channel_metrics": metrics,
                "_cached_upload_dates": {"aug": datetime(2026, 8, 1), "jul": datetime(2026, 7, 1), "sep": datetime(2026, 9, 1)},
                "_cached_rows": rows,
                "saved_plan_years": set(),
                "category_plans_for_year": dict.fromkeys(dashboard.CATEGORY_MONTHLY_PLANS, 0),
                "plans_for_year": {},
                "_language_lab_monthly": {},
                "_state_performance": ([], []),
                "_period_order_counts": dict.fromkeys(("DSG", "SFH", "Amazon", "Direct Sales"), 0),
            }
            for name, value in mocks.items():
                stack.enter_context(patch.object(dashboard, name, return_value=value))
            for channel, expected in (("all", 175), ("direct", 125), ("dsg", 50)):
                with self.subTest(channel=channel):
                    result = dashboard._build_dashboard_kpis(
                        channel=channel, grain="monthly", period="8", year=2026,
                        comparison_grain="monthly", comparison_period="7", comparison_year=2026,
                        view="state",
                    )
                    cards = {card["id"]: card for card in result["cards"]}
                    card = cards["pnl"]
                    self.assertEqual(card["total"], expected)
                    self.assertEqual(sum(item["value"] for item in card["breakdown"]), expected)
                    self.assertEqual(card["previous_total"], 0 if channel == "dsg" else 10)
                    self.assertEqual(card["trend"], [expected])
                    self.assertEqual(cards["taxable"]["total"], 0)
                    breakdown = {item["label"]: item["value"] for item in card["breakdown"]}
                    if channel == "direct":
                        self.assertEqual(breakdown["Language Lab"], 25)
                        self.assertEqual(breakdown["Books"], 100)
                    elif channel == "all":
                        self.assertEqual(breakdown["Direct Sales"], 125)
                    else:
                        self.assertNotIn("Language Lab", breakdown)
        self.assertEqual(metrics["direct"]["pnl"], 100)
