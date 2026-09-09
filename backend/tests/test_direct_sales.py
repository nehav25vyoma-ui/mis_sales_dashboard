import asyncio
from io import BytesIO
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException, UploadFile

from app.uploads import direct_sales
from app.uploads import dsg
from sqlalchemy.exc import SQLAlchemyError


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

    def test_reupload_resumes_pending_review_and_preserves_category_choices(self):
        def upload_files():
            return asyncio.run(direct_sales.upload_direct_sales(
                _upload("invoice.csv", "Invoice Number,Without Tax Total,Private Notes\n1001,100,\n"),
                _upload("inventory.csv", "Doc No.,Category,Item Details,Qty\n1001,Unknown,Alpha,1\n"),
            ))

        with patch.object(direct_sales, "SessionLocal", return_value=_Database()):
            first = upload_files()
            self.assertTrue(first["required_reviews"]["category"])
            row = direct_sales.get_category_review(first["upload_id"])["records"][0]
            direct_sales.update_category(first["upload_id"], row["row_id"],
                                        direct_sales.DirectSalesCategoryUpdate(category="Language Lab"))
            resumed = upload_files()

        self.assertEqual(resumed["upload_id"], first["upload_id"])
        self.assertFalse(resumed["required_reviews"]["category"])
        self.assertEqual(len(direct_sales.DIRECT_SALES_UPLOAD_STORE), 1)
        pending = direct_sales.DIRECT_SALES_UPLOAD_STORE[first["upload_id"]]
        self.assertEqual(pending["frame"].iloc[0][pending["resolved_columns"]["category"]], "Language Lab")

    def test_history_deletion_clears_matching_pending_review_only_after_commit(self):
        for commit_fails in (True, False):
            with self.subTest(commit_fails=commit_fails):
                direct_sales.DIRECT_SALES_UPLOAD_STORE.clear()
                direct_sales.DIRECT_SALES_UPLOAD_STORE.update({
                    "pending": {"dataset_hash": "same"},
                    "unrelated": {"dataset_hash": "other"},
                })
                database = MagicMock()
                database.__enter__.return_value = database
                database.get.return_value = SimpleNamespace(channel="DIRECT SALES", dataset_hash="same")
                if commit_fails:
                    database.commit.side_effect = SQLAlchemyError("commit failed")
                with patch.object(dsg, "SessionLocal", return_value=database):
                    if commit_fails:
                        with self.assertRaises(HTTPException):
                            dsg.delete_upload_history("saved")
                        self.assertIn("pending", direct_sales.DIRECT_SALES_UPLOAD_STORE)
                    else:
                        self.assertTrue(dsg.delete_upload_history("saved")["deleted"])
                        self.assertNotIn("pending", direct_sales.DIRECT_SALES_UPLOAD_STORE)
                self.assertIn("unrelated", direct_sales.DIRECT_SALES_UPLOAD_STORE)

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
            ["In Office", "In Office", "Stall", "Stall"],
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

    def test_quantity_alone_does_not_classify_bulk(self):
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
        self.assertEqual(set(bulk_rows["Sales Classification"]), {"In Office"})

    def test_rejects_a_missing_dataset(self):
        invoice = _upload(
            "invoice.csv",
            "Invoice Number,Without Tax Total,Private Notes\n1001,100,\n",
        )
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(direct_sales.upload_direct_sales(invoice, None))
        self.assertIn("Sales Inventory Dataset", str(raised.exception.detail))

    def test_sales_classification_is_mutually_exclusive_with_stall_precedence(self):
        self.assertEqual(direct_sales._sales_classification("Language Lab order", 25), "Language Lab")
        self.assertEqual(direct_sales._sales_classification("Annual STALL event", 25), "Stall")
        self.assertEqual(direct_sales._sales_classification("", 11), "In Office")
        self.assertEqual(direct_sales._sales_classification("BULK order", 1), "Bulk")
        self.assertEqual(direct_sales._sales_classification("", 25, "Bulk Book"), "In Office")
        self.assertEqual(direct_sales._sales_classification("stall bulk", 1), "Stall")
        self.assertEqual(direct_sales._sales_classification("vendant bulk", 1), "Retail")
        self.assertEqual(direct_sales._sales_classification("call bulk", 1), "Call")
        self.assertEqual(direct_sales._sales_classification("direct sale in office by phaneendra", 1), "In Office")
        self.assertEqual(direct_sales._sales_classification("PHONE order", 1), "Call")
        self.assertEqual(direct_sales._sales_classification("", 1, "Phone Call Book"), "In Office")
        self.assertEqual(direct_sales._sales_classification("callback", 1), "In Office")
        self.assertEqual(direct_sales._sales_classification("please call this phone", 10), "Call")
        self.assertEqual(direct_sales._sales_classification("VENDANT", 10), "Retail")
        self.assertEqual(direct_sales._sales_classification("vendant", 25), "Retail")
        self.assertEqual(direct_sales._sales_classification("Retail sales Vedanta book house", 1), "Retail")
        self.assertEqual(direct_sales._sales_classification("VEDANTA", 25), "Retail")
        self.assertEqual(direct_sales._sales_classification("Vedanta stall", 1), "Stall")
        self.assertEqual(direct_sales._sales_classification("", 25, customer_name="Vedantha Book House"), "Retail")
        self.assertEqual(direct_sales._sales_classification("stall", 25, customer_name="Vedantha Book House"), "Stall")
        self.assertEqual(direct_sales._sales_classification("", 1, customer_name="Vedanta Bhum a"), "In Office")
        self.assertEqual(direct_sales._sales_classification("", 10), "In Office")
        self.assertEqual(direct_sales._sales_classification("vendant stall", 1), "Stall")
        self.assertEqual(direct_sales._sales_classification("Language Lab", 10), "Language Lab")
        self.assertEqual(direct_sales._sales_classification("S101 course", 1), "In Office")
        self.assertEqual(direct_sales._sales_classification("grammar", 1), "In Office")
        self.assertEqual(direct_sales._sales_classification("grammer", 1), "In Office")
        self.assertEqual(direct_sales._sales_classification(None, "", "  "), "In Office")
        self.assertEqual(direct_sales._sales_classification("call language lab", 1), "Call")


if __name__ == "__main__":
    unittest.main()
