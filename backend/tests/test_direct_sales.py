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
            ["Call", "Call", "Stall", "Stall"],
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

    def test_bulk_uses_individual_quantity_within_each_mapped_invoice(self):
        invoice = _upload(
            "invoice.csv",
            "Invoice Number,Without Tax Total,Private Notes\n1001,110,\n1002,100,\n1003,110,\n",
        )
        inventory = _upload(
            "inventory.csv",
            "Doc No.,Category,Item Details,Qty\n"
            "1001,Books,A,3\n1001,Books,B,3\n1001,Books,C,3\n1001,Books,D,2\n"
            "1002,Books,E,5\n1002,Books,F,5\n1003,Books,G,11\n",
        )
        with patch.object(direct_sales, "SessionLocal", return_value=_Database()):
            result = asyncio.run(direct_sales.upload_direct_sales(invoice, inventory))

        frame = direct_sales.DIRECT_SALES_UPLOAD_STORE[str(result["upload_id"])]["frame"]
        invoice_column = "Invoice Number"
        summed_rows = frame.loc[frame[invoice_column] == 1001]
        boundary_rows = frame.loc[frame[invoice_column] == 1002]
        bulk_rows = frame.loc[frame[invoice_column] == 1003]
        self.assertEqual(set(summed_rows["Mapped Quantity"]), {11.0})
        self.assertEqual(set(summed_rows["Sales Classification"]), {"In Office"})
        self.assertEqual(set(boundary_rows["Mapped Quantity"]), {10.0})
        self.assertEqual(set(boundary_rows["Sales Classification"]), {"In Office"})
        self.assertEqual(set(bulk_rows["Bulk Classification Quantity"]), {11.0})
        self.assertEqual(set(bulk_rows["Sales Classification"]), {"Bulk"})

    def test_rejects_a_missing_dataset(self):
        invoice = _upload(
            "invoice.csv",
            "Invoice Number,Without Tax Total,Private Notes\n1001,100,\n",
        )
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(direct_sales.upload_direct_sales(invoice, None))
        self.assertIn("Sales Inventory Dataset", str(raised.exception.detail))

    def test_sales_classification_is_mutually_exclusive_with_stall_precedence(self):
        self.assertEqual(direct_sales._sales_classification("Language Lab order", 25), "Bulk")
        self.assertEqual(direct_sales._sales_classification("Annual STALL event", 25), "Stall")
        self.assertEqual(direct_sales._sales_classification("", 11), "Bulk")
        self.assertEqual(direct_sales._sales_classification("please call this phone", 10), "Call")
        self.assertEqual(direct_sales._sales_classification("VENDANT", 10), "Retail")
        self.assertEqual(direct_sales._sales_classification("vendant", 25), "Retail")
        self.assertEqual(direct_sales._sales_classification("", 10), "In Office")
        self.assertEqual(direct_sales._sales_classification("vendant stall", 1), "Stall")
        self.assertEqual(direct_sales._sales_classification("Language Lab", 10), "Language Lab")
        self.assertEqual(direct_sales._sales_classification("S101 course", 1), "Course Promotion")
        self.assertEqual(direct_sales._sales_classification("grammar", 1), "In Office")
        self.assertEqual(direct_sales._sales_classification("grammer", 1), "Course Promotion")
        self.assertEqual(direct_sales._sales_classification(None, "", "  "), "In Office")
        self.assertEqual(direct_sales._sales_classification("call language lab", 1), "Call")


if __name__ == "__main__":
    unittest.main()
