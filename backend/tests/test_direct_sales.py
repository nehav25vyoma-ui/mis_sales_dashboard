import asyncio
from io import BytesIO
import unittest
from unittest.mock import patch

from fastapi import HTTPException, UploadFile

from app.uploads import direct_sales


class _Query:
    def filter_by(self, **_kwargs):
        return self

    def first(self):
        return None


class _Database:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def query(self, *_args):
        return _Query()


def _upload(name: str, content: str) -> UploadFile:
    return UploadFile(filename=name, file=BytesIO(content.encode()))


class DirectSalesUploadTests(unittest.TestCase):
    def setUp(self):
        direct_sales.DIRECT_SALES_UPLOAD_STORE.clear()

    def test_maps_without_multiplying_invoice_rows_and_logs_unmatched(self):
        invoice = _upload(
            "invoice.csv",
            "Invoice Number,Without Tax Total,Private Notes\n1001,100,\n1001,200,Stall counter\n1002,50,\n",
        )
        inventory = _upload(
            "inventory.csv",
            "Doc No.,Category,Item Details,- Qty\n1001,books,Alpha Book,6\n1001,Web Version,Alpha Web,5\n1003,Web Version,Other,1\n",
        )
        with patch.object(direct_sales, "SessionLocal", return_value=_Database()):
            result = asyncio.run(direct_sales.upload_direct_sales(invoice, inventory))

        self.assertEqual(result["matched"], 2)
        self.assertEqual(result["unmatched"], 2)
        upload = direct_sales.DIRECT_SALES_UPLOAD_STORE[str(result["upload_id"])]
        frame = upload["frame"]
        self.assertEqual(len(frame.index), 4)
        self.assertEqual(list(frame["Category"]), ["Books", "Web Version", "Books", "Web Version"])
        self.assertEqual(list(frame["Product Name"]), ["Alpha Book", "Alpha Web", "Alpha Book", "Alpha Web"])
        self.assertEqual(list(frame["Mapped Quantity"]), [11.0, 11.0, 11.0, 11.0])
        self.assertEqual(
            list(frame["Sales Classification"]),
            ["Bulk Sales", "Bulk Sales", "Stall Sales", "Stall Sales"],
        )
        self.assertAlmostEqual(frame["Without Tax Total"].sum(), 300.0)
        product_totals = frame.groupby("Product Name")["Without Tax Total"].sum()
        self.assertAlmostEqual(product_totals["Alpha Book"], 300.0 * 6 / 11)
        self.assertAlmostEqual(product_totals["Alpha Web"], 300.0 * 5 / 11)

    def test_rejects_a_missing_required_column(self):
        invoice = _upload(
            "invoice.csv",
            "Invoice Number,Without Tax Total,Private Notes\n1001,100,\n",
        )
        inventory = _upload("inventory.csv", "Doc No.,Category,Quantity\n1001,Books,1\n")
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(direct_sales.upload_direct_sales(invoice, inventory))
        self.assertIn("Item Details", str(raised.exception.detail))

    def test_rejects_a_missing_dataset(self):
        invoice = _upload(
            "invoice.csv",
            "Invoice Number,Without Tax Total,Private Notes\n1001,100,\n",
        )
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(direct_sales.upload_direct_sales(invoice, None))
        self.assertIn("Sales Inventory Dataset", str(raised.exception.detail))

    def test_sales_classification_is_mutually_exclusive_with_stall_precedence(self):
        self.assertEqual(direct_sales._sales_classification("Annual STALL event", 25), "Stall Sales")
        self.assertEqual(direct_sales._sales_classification("", 11), "Bulk Sales")
        self.assertEqual(direct_sales._sales_classification("", 10), "Direct Sales")


if __name__ == "__main__":
    unittest.main()
