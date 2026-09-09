from datetime import datetime, timezone
import hashlib
from pathlib import Path
import re
from typing import Literal
from uuid import uuid4

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.database.database import SessionLocal
from app.database.models import DirectSalesDatasetRow, UploadHistory
from app.direct_sales_classification import classify_direct_sale
from app.uploads.dsg import (
    ALLOWED_EXTENSIONS,
    CATEGORY_MAPPING,
    MAX_FILE_SIZE,
    ProductUpdate,
    STANDARD_CATEGORIES,
    _json_value,
    _normalise_header,
    _product_groups,
    _read_dataset,
)

router = APIRouter(prefix="/api/uploads", tags=["uploads"])
DIRECT_SALES_UPLOAD_STORE: dict[str, dict[str, object]] = {}
DIRECT_SALES_CATEGORIES = (*STANDARD_CATEGORIES, "N/A", "Language Lab")


class DirectSalesCategoryUpdate(BaseModel):
    category: Literal["Books", "Web Version", "Audio Device", "Pen Drive", "N/A", "Language Lab"]

AMOUNT_ALIASES = (
    "without tax total",
    "amount",
    "invoice amount",
    "total amount",
    "net amount",
    "grand total",
    "taxable value",
)


def _column(frame: pd.DataFrame, required_name: str) -> str | None:
    def header_key(value: object) -> str:
        return re.sub(r"[^a-z0-9]+", "", _normalise_header(value))

    available = {header_key(column): str(column) for column in frame.columns}
    aliases = {
        "Quantity": ("quantity", "qty"),
    }
    accepted = aliases.get(required_name, (_normalise_header(required_name),))
    return next(
        (available[header_key(name)] for name in accepted if header_key(name) in available),
        None,
    )


def _invoice_key(value: object) -> str:
    if pd.isna(value):
        return ""
    text = str(value).strip()
    return re.sub(r"\.0$", "", text)


def _sales_classification(private_notes: object, quantity: object, *text_values: object, customer_name: object = None) -> str:
    return classify_direct_sale((private_notes, *text_values), quantity, customer_name=customer_name, private_notes=private_notes)


async def _validated_file(file: UploadFile, dataset_label: str) -> tuple[str, bytes, pd.DataFrame]:
    filename = Path(file.filename or "").name
    extension = Path(filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported {dataset_label} file type. Upload a CSV, XLSX, or XLS file.",
        )
    content = await file.read(MAX_FILE_SIZE + 1)
    await file.close()
    if not content:
        raise HTTPException(status_code=422, detail=f"The {dataset_label} is empty.")
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail=f"The {dataset_label} exceeds the 50 MB upload limit.")
    frame = _read_dataset(content, extension)
    if frame.empty:
        raise HTTPException(status_code=422, detail=f"The {dataset_label} contains no records.")
    return filename, content, frame


def _required_columns(
    frame: pd.DataFrame,
    dataset_label: str,
    requirements: tuple[str, ...],
) -> dict[str, str]:
    resolved = {name: _column(frame, name) for name in requirements}
    missing = [name for name, column in resolved.items() if column is None]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=(
                f"The {dataset_label} is missing mandatory column"
                f"{'s' if len(missing) != 1 else ''}: {', '.join(missing)}. "
                f"Detected columns: {', '.join(map(str, frame.columns))}."
            ),
        )
    return {name: str(column) for name, column in resolved.items()}


def _get_upload(upload_id: str) -> dict[str, object]:
    upload = DIRECT_SALES_UPLOAD_STORE.get(upload_id)
    if upload is None:
        raise HTTPException(
            status_code=404,
            detail="Direct Sales upload session not found. Please upload both files again.",
        )
    return upload


def _json_records(frame: pd.DataFrame) -> list[dict[str, object]]:
    return [
        {str(column): _json_value(row[column]) for column in frame.columns}
        for _, row in frame.iterrows()
    ]


def _category_rows(upload: dict[str, object]) -> list[dict[str, object]]:
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    rows: list[dict[str, object]] = []
    for index, row in frame.iterrows():
        category = str(row[columns["category"]]).strip()
        if category in DIRECT_SALES_CATEGORIES:
            continue
        rows.append(
            {
                "row_id": int(index),
                "order_number": _json_value(row[columns["order_number"]]),
                "product_name": _json_value(row[columns["product_name"]]),
                "original_category": category,
                "amount": _json_value(row[columns["amount"]]) if columns.get("amount") else None,
                "is_combo": False,
            }
        )
    return rows


@router.post("/direct-sales")
async def upload_direct_sales(
    invoice_file: UploadFile | None = File(None),
    inventory_file: UploadFile | None = File(None),
) -> dict[str, object]:
    if invoice_file is None or inventory_file is None:
        missing = []
        if invoice_file is None:
            missing.append("Invoice Dataset")
        if inventory_file is None:
            missing.append("Sales Inventory Dataset")
        raise HTTPException(
            status_code=422,
            detail=f"Direct Sales requires both files. Missing: {', '.join(missing)}.",
        )

    invoice_name, invoice_content, invoice = await _validated_file(invoice_file, "Invoice Dataset")
    inventory_name, inventory_content, inventory = await _validated_file(
        inventory_file, "Sales Inventory Dataset"
    )
    invoice_columns = _required_columns(
        invoice,
        "Invoice Dataset",
        ("Invoice Number", "Without Tax Total", "Private Notes"),
    )
    inventory_columns = _required_columns(
        inventory,
        "Sales Inventory Dataset",
        ("Doc No.", "Category", "Item Details", "Quantity"),
    )
    client_name_column = _column(invoice, "Client Name")
    dataset_hash = hashlib.sha256(invoice_content + b"\0" + inventory_content).hexdigest()
    with SessionLocal() as database:
        duplicate = database.query(UploadHistory).filter_by(dataset_hash=dataset_hash).first()
        if duplicate:
            raise HTTPException(
                status_code=409,
                detail=f"These Direct Sales datasets were already uploaded. Dataset ID: {duplicate.upload_id}.",
            )
    for pending_id, pending_upload in DIRECT_SALES_UPLOAD_STORE.items():
        if pending_upload.get("dataset_hash") == dataset_hash:
            return _upload_response(pending_id, pending_upload)

    invoice = invoice.copy()
    inventory = inventory.copy()
    invoice["_mapping_key"] = invoice[invoice_columns["Invoice Number"]].map(_invoice_key)
    inventory["_mapping_key"] = inventory[inventory_columns["Doc No."]].map(_invoice_key)
    invoice_keys = set(invoice["_mapping_key"]) - {""}
    inventory_keys = set(inventory["_mapping_key"]) - {""}
    matched_keys = invoice_keys & inventory_keys

    unmatched_invoice = invoice.loc[~invoice["_mapping_key"].isin(matched_keys)].copy()
    unmatched_inventory = inventory.loc[~inventory["_mapping_key"].isin(matched_keys)].copy()
    matched_invoice = invoice.loc[invoice["_mapping_key"].isin(matched_keys)].copy()
    if matched_invoice.empty:
        raise HTTPException(
            status_code=422,
            detail="No records matched Invoice Dataset → Invoice Number with Sales Inventory Dataset → Doc No.",
        )

    inventory_amount_column = _column(inventory, "Amount")
    allocations: dict[str, list[dict[str, object]]] = {}
    category_conflicts: list[dict[str, object]] = []
    for key, group in inventory.loc[inventory["_mapping_key"].isin(matched_keys)].groupby(
        "_mapping_key", sort=False
    ):
        prepared = group.copy()
        prepared["_standard_category"] = prepared[inventory_columns["Category"]].apply(
            lambda value: CATEGORY_MAPPING.get(
                str(value).strip().casefold(), str(value).strip()
            )
        )
        prepared["_quantity"] = pd.to_numeric(
            prepared[inventory_columns["Quantity"]], errors="coerce"
        ).fillna(0)
        total_quantity = float(prepared["_quantity"].sum())
        bulk_classification_quantity = float(prepared["_quantity"].max())
        product_parts: list[dict[str, object]] = []
        for source_index, inventory_row in prepared.iterrows():
            inventory_amount = (
                float(pd.to_numeric(
                    pd.Series([inventory_row[inventory_amount_column]]), errors="coerce"
                ).fillna(0).iloc[0])
                if inventory_amount_column is not None
                else 0.0
            )
            product_parts.append(
                {
                    "category": str(inventory_row["_standard_category"]),
                    "product": (
                        "" if pd.isna(inventory_row[inventory_columns["Item Details"]])
                        else str(inventory_row[inventory_columns["Item Details"]]).strip()
                    ),
                    "quantity": float(inventory_row["_quantity"]),
                    "inventory_amount": inventory_amount,
                    "inventory_source_row": int(source_index) + 2,
                }
            )
        distinct_categories = list(dict.fromkeys(
            str(part["category"]) for part in product_parts
        ))
        if len(distinct_categories) > 1:
            category_conflicts.append(
                {"doc_no": str(key), "categories": distinct_categories}
            )
        amount_weight = sum(abs(float(part["inventory_amount"])) for part in product_parts)
        quantity_weight = sum(abs(float(part["quantity"])) for part in product_parts)
        for part in product_parts:
            part["weight"] = (
                abs(float(part["inventory_amount"])) / amount_weight
                if amount_weight
                else abs(float(part["quantity"])) / quantity_weight
                if quantity_weight
                else 1 / max(len(product_parts), 1)
            )
            part["total_quantity"] = total_quantity
            part["bulk_classification_quantity"] = bulk_classification_quantity
        allocations[str(key)] = product_parts

    # Split only genuinely mixed-category invoices. The allocated values always
    # add back to Invoice → Without Tax Total, so KPI totals are not duplicated.
    allocated_rows: list[pd.Series] = []
    for _, invoice_row in matched_invoice.iterrows():
        key = str(invoice_row["_mapping_key"])
        parts = allocations.get(key, [])
        if not parts:
            continue
        original_amount = pd.to_numeric(
            pd.Series([invoice_row[invoice_columns["Without Tax Total"]]]),
            errors="coerce",
        ).fillna(0).iloc[0]
        allocated_so_far = 0.0
        for part_index, part in enumerate(parts):
            row = invoice_row.copy()
            allocated_amount = (
                float(original_amount) - allocated_so_far
                if part_index == len(parts) - 1
                else float(original_amount) * float(part["weight"])
            )
            allocated_so_far += allocated_amount
            row["Original Without Tax Total"] = float(original_amount)
            row[invoice_columns["Without Tax Total"]] = allocated_amount
            row["Category"] = part["category"]
            row["Item Details"] = part["product"]
            row["Product Name"] = part["product"]
            row["Category Quantity"] = part["quantity"]
            row["Inventory Source Row"] = part["inventory_source_row"]
            row["Inventory Line Amount"] = part["inventory_amount"]
            row["Mapped Quantity"] = part["total_quantity"]
            row["Bulk Classification Quantity"] = part["quantity"]
            row["Sales Classification"] = _sales_classification(
                row[invoice_columns["Private Notes"]],
                part["quantity"],
                part["product"],
                part["category"],
                customer_name=row.get(client_name_column, ""),
            )
            allocated_rows.append(row)
    matched = pd.DataFrame(allocated_rows)
    matched.drop(columns=["_mapping_key"], inplace=True)
    matched.index = range(len(matched.index))

    amount_column = invoice_columns["Without Tax Total"]
    upload_id = str(uuid4())
    upload: dict[str, object] = {
        "frame": matched,
        "resolved_columns": {
            "order_number": invoice_columns["Invoice Number"],
            "product_name": "Product Name",
            "source_product_name": "Item Details",
            "category": "Category",
            "amount": amount_column,
        },
        "file_name": f"{invoice_name} + {inventory_name}",
        "dataset_hash": dataset_hash,
        "uploaded_at": datetime.now(timezone.utc),
        "uploaded_by": "Admin User",
        "reviewed_product_rows": set(),
        "counts": {
            "processed": len(invoice.index) + len(inventory.index),
            "invoice_records": len(invoice.index),
            "inventory_records": len(inventory.index),
            "matched": len(matched_invoice.index),
            "final_records": len(matched.index),
            "unmatched": len(unmatched_invoice.index) + len(unmatched_inventory.index),
            "unmatched_invoice": len(unmatched_invoice.index),
            "unmatched_inventory": len(unmatched_inventory.index),
        },
        "unmatched_invoice": _json_records(unmatched_invoice.drop(columns=["_mapping_key"])),
        "unmatched_inventory": _json_records(unmatched_inventory.drop(columns=["_mapping_key"])),
        "category_conflicts": category_conflicts,
    }
    DIRECT_SALES_UPLOAD_STORE[upload_id] = upload
    return _upload_response(upload_id, upload)


def _upload_response(upload_id: str, upload: dict[str, object]) -> dict[str, object]:
    category_rows = _category_rows(upload)
    product_groups = _product_groups(upload)
    return {
        "upload_id": upload_id,
        "file_name": upload["file_name"],
        "channel": "DIRECT SALES",
        **upload["counts"],
        "category_conflicts": len(upload["category_conflicts"]),
        "category_review_count": len(category_rows),
        "product_review_count": len(product_groups),
        "required_reviews": {
            "category": bool(category_rows),
            "product": bool(product_groups),
        },
        "next_step": "category_review" if category_rows else "product_review" if product_groups else "save_dataset",
        "status": "validated",
    }


@router.get("/direct-sales/{upload_id}/unmatched")
def get_unmatched(upload_id: str) -> dict[str, object]:
    upload = _get_upload(upload_id)
    return {
        "upload_id": upload_id,
        "counts": upload["counts"],
        "invoice_records": upload["unmatched_invoice"],
        "inventory_records": upload["unmatched_inventory"],
        "category_conflicts": upload["category_conflicts"],
    }


@router.delete("/direct-sales/{upload_id}")
def discard_upload(upload_id: str) -> dict[str, object]:
    if DIRECT_SALES_UPLOAD_STORE.pop(upload_id, None) is None:
        raise HTTPException(status_code=404, detail="Direct Sales upload session not found.")
    return {"deleted": True, "upload_id": upload_id}


@router.get("/direct-sales/{upload_id}/category-review")
def get_category_review(upload_id: str) -> dict[str, object]:
    rows = _category_rows(_get_upload(upload_id))
    return {
        "upload_id": upload_id,
        "records": rows,
        "remaining": len(rows),
        "completed": not rows,
        "standard_categories": DIRECT_SALES_CATEGORIES,
    }


@router.patch("/direct-sales/{upload_id}/category-review/{row_id}")
def update_category(upload_id: str, row_id: int, update: DirectSalesCategoryUpdate) -> dict[str, object]:
    upload = _get_upload(upload_id)
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    if row_id not in frame.index:
        raise HTTPException(status_code=404, detail="Direct Sales review record not found.")
    frame.at[row_id, columns["category"]] = update.category
    rows = _category_rows(upload)
    return {"updated": True, "remaining": len(rows), "completed": not rows}


@router.get("/direct-sales/{upload_id}/product-review")
def get_product_review(upload_id: str) -> dict[str, object]:
    upload = _get_upload(upload_id)
    if _category_rows(upload):
        raise HTTPException(status_code=409, detail="Complete Category Review before opening Product Review.")
    groups = _product_groups(upload)
    return {"upload_id": upload_id, "groups": groups, "remaining": len(groups), "completed": not groups}


@router.patch("/direct-sales/{upload_id}/product-review/{group_id}")
def update_product(
    upload_id: str, group_id: str, update: ProductUpdate
) -> dict[str, object]:
    upload = _get_upload(upload_id)
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    group = next((item for item in _product_groups(upload) if item["group_id"] == group_id), None)
    if group is None:
        raise HTTPException(status_code=404, detail="Direct Sales Product Review group not found.")
    if {item.original_name for item in update.mappings} != set(group["variations"]):
        raise HTTPException(status_code=422, detail="Provide a Standard Product Name for every variation.")
    group_rows = set(int(row_id) for row_id in group["row_ids"])
    updated: set[int] = set()
    for mapping in update.mappings:
        matching = [
            index for index in group_rows
            if str(frame.at[index, columns["product_name"]]).strip() == mapping.original_name
        ]
        frame.loc[matching, columns["product_name"]] = mapping.standard_name.strip()
        updated.update(matching)
    reviewed = upload["reviewed_product_rows"]
    assert isinstance(reviewed, set)
    reviewed.update(group_rows)
    groups = _product_groups(upload)
    return {
        "updated": True,
        "updated_records": len(updated),
        "remaining": len(groups),
        "completed": not groups,
    }


@router.post("/direct-sales/{upload_id}/complete")
def complete_upload(upload_id: str) -> dict[str, object]:
    upload = _get_upload(upload_id)
    if _category_rows(upload):
        raise HTTPException(status_code=409, detail="Complete Direct Sales Category Review before saving.")
    if _product_groups(upload):
        raise HTTPException(status_code=409, detail="Complete Direct Sales Product Review before saving.")
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    with SessionLocal() as database:
        database.add(
            UploadHistory(
                upload_id=upload_id,
                dataset_hash=str(upload["dataset_hash"]),
                file_name=str(upload["file_name"]),
                channel="DIRECT SALES",
                uploaded_at=upload["uploaded_at"],
                uploaded_by=str(upload["uploaded_by"]),
                total_records=len(frame.index),
                upload_status="Completed",
            )
        )
        for source_number, (_, row) in enumerate(frame.iterrows(), start=1):
            database.add(
                DirectSalesDatasetRow(
                    upload_id=upload_id,
                    source_row_number=source_number,
                    order_number=str(_json_value(row[columns["order_number"]]) or ""),
                    product_name=str(_json_value(row[columns["product_name"]]) or ""),
                    category=str(_json_value(row[columns["category"]]) or ""),
                    amount=(
                        str(_json_value(row[columns["amount"]]) or "")
                        if columns.get("amount") else ""
                    ),
                    row_data={str(column): _json_value(row[column]) for column in frame.columns},
                )
            )
        try:
            database.commit()
        except IntegrityError as exc:
            database.rollback()
            raise HTTPException(status_code=409, detail="These Direct Sales datasets already exist.") from exc
        except SQLAlchemyError as exc:
            database.rollback()
            raise HTTPException(
                status_code=503, detail="The Direct Sales dataset could not be saved to PostgreSQL."
            ) from exc
    DIRECT_SALES_UPLOAD_STORE.pop(upload_id, None)
    return {
        "upload_id": upload_id,
        "file_name": upload["file_name"],
        "channel": "DIRECT SALES",
        "total_records": len(frame.index),
        **upload["counts"],
        "status": "Completed",
    }
