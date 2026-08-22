from io import BytesIO
from difflib import SequenceMatcher
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import re
from typing import Literal
from uuid import uuid4

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.database.database import SessionLocal
from app.database.models import DSGDatasetRow, UploadHistory
from app.calculations.amounts import dsg_amount_column

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

MAX_FILE_SIZE = 50 * 1024 * 1024
ALLOWED_EXTENSIONS = {".csv", ".xlsx", ".xls"}
STANDARD_CATEGORIES = ("Books", "Web Version", "Audio Device", "Pen Drive")
PRODUCT_REVIEWED_MARKER = "__mis_product_reviewed"
CATEGORY_MAPPING = {
    "books": "Books",
    "book - paperback": "Books",
    "flipbook": "Web Version",
    "learning path": "Web Version",
    "web version": "Web Version",
    "audio device": "Audio Device",
    "pen drive": "Pen Drive",
    "pendrive": "Pen Drive",
}
# Only headers are normalised here. Business values and calculations are left
# untouched for the review workflow.
COLUMN_ALIASES = {
    "order_number": {"order number", "order no", "order id", "ordernumber"},
    "product_name": {"product name", "product", "item name", "productname"},
    "category": {"category", "product category"},
}
def _normalise_header(value: object) -> str:
    return " ".join(str(value).strip().lower().replace("_", " ").split())


def _read_dataset(content: bytes, extension: str) -> pd.DataFrame:
    source = BytesIO(content)
    try:
        if extension == ".csv":
            try:
                return pd.read_csv(source)
            except UnicodeDecodeError:
                source.seek(0)
                return pd.read_csv(source, encoding="latin-1")
        return pd.read_excel(source)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="The file could not be read. Check that it is a valid, non-corrupted CSV or Excel file.",
        ) from exc


def _validate_columns(frame: pd.DataFrame) -> dict[str, str]:
    available = {_normalise_header(column): str(column) for column in frame.columns}
    resolved: dict[str, str] = {}
    missing: list[str] = []

    for canonical, aliases in COLUMN_ALIASES.items():
        match = next((available[alias] for alias in aliases if alias in available), None)
        if match:
            resolved[canonical] = match
        else:
            missing.append(canonical.replace("_", " ").title())

    amount_match = dsg_amount_column(list(frame.columns))
    if amount_match:
        resolved["amount"] = amount_match
    else:
        missing.append("Item Cost × Quantity")

    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "This file is not a valid DSG dataset. "
                f"Missing mandatory DSG columns: {', '.join(missing)}."
            ),
        )
    return resolved


class CategoryUpdate(BaseModel):
    category: Literal["Books", "Web Version", "Audio Device", "Pen Drive"]


class ComboPart(BaseModel):
    category: Literal["Books", "Web Version", "Audio Device", "Pen Drive"]
    amount: float = Field(gt=0)


class ComboUpdate(BaseModel):
    parts: list[ComboPart] = Field(min_length=2)


class ProductNameMapping(BaseModel):
    original_name: str = Field(min_length=1, max_length=500)
    standard_name: str = Field(min_length=1, max_length=500)


class ProductUpdate(BaseModel):
    mappings: list[ProductNameMapping] = Field(min_length=1)


def _serialise_value(value: object) -> object:
    if pd.isna(value):
        return None
    if hasattr(value, "item"):
        return value.item()
    return value


def _json_value(value: object) -> object:
    value = _serialise_value(value)
    if isinstance(value, (datetime, pd.Timestamp)):
        return value.isoformat()
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _review_rows(upload: dict[str, object]) -> list[dict[str, object]]:
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    category_column = columns["category"]
    review: list[dict[str, object]] = []
    for index, row in frame.iterrows():
        category = str(row[category_column]).strip()
        if category in STANDARD_CATEGORIES:
            continue
        review.append(
            {
                "row_id": int(index),
                "order_number": _serialise_value(row[columns["order_number"]]),
                "product_name": _serialise_value(row[columns["product_name"]]),
                "original_category": category,
                "amount": _serialise_value(row[columns["amount"]]),
                "is_combo": category.casefold() == "combo",
            }
        )
    return review


def _get_upload(upload_id: str) -> dict[str, object]:
    with SessionLocal() as database:
        history = database.query(UploadHistory).filter(
            UploadHistory.upload_id == upload_id,
            UploadHistory.channel == "DSG",
            UploadHistory.upload_status == "Reviewing",
        ).first()
        if history is None:
            raise HTTPException(status_code=404, detail="Upload session not found. Please upload the file again.")
        rows = database.query(DSGDatasetRow).filter_by(upload_id=upload_id).order_by(
            DSGDatasetRow.source_row_number
        ).all()
        if not rows:
            raise HTTPException(status_code=404, detail="Upload session not found. Please upload the file again.")
        reviewed_product_rows = {
            index
            for index, row in enumerate(rows)
            if bool(row.row_data.get(PRODUCT_REVIEWED_MARKER))
        }
        frame = pd.DataFrame([
            {
                key: value
                for key, value in row.row_data.items()
                if key != PRODUCT_REVIEWED_MARKER
            }
            for row in rows
        ])
        frame.index = range(len(frame.index))
        return {
            "frame": frame,
            "resolved_columns": _validate_columns(frame),
            "file_name": history.file_name,
            "channel": "DSG",
            "dataset_hash": history.dataset_hash,
            "uploaded_at": history.uploaded_at,
            "uploaded_by": history.uploaded_by,
            "reviewed_product_rows": reviewed_product_rows,
            "upload_id": upload_id,
        }


def _save_upload(upload: dict[str, object]) -> None:
    """Persist the in-review DSG frame so Vercel instances can change safely."""
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    reviewed_product_rows = upload.get("reviewed_product_rows", set())
    assert isinstance(reviewed_product_rows, set)
    with SessionLocal() as database:
        database.query(DSGDatasetRow).filter_by(upload_id=str(upload["upload_id"])).delete(
            synchronize_session=False
        )
        for source_number, (row_id, row) in enumerate(frame.iterrows(), start=1):
            row_data = {str(column): _json_value(row[column]) for column in frame.columns}
            if int(row_id) in reviewed_product_rows:
                row_data[PRODUCT_REVIEWED_MARKER] = True
            database.add(DSGDatasetRow(
                upload_id=str(upload["upload_id"]),
                source_row_number=source_number,
                order_number=str(_json_value(row[columns["order_number"]]) or ""),
                product_name=str(_json_value(row[columns["product_name"]]) or ""),
                category=str(_json_value(row[columns["category"]]) or ""),
                amount=str(_json_value(row[columns["amount"]]) or ""),
                row_data=row_data,
            ))
        database.commit()


def _product_key(value: object) -> str:
    text = str(value).strip().casefold()
    return re.sub(r"[^a-z]+", "", text)


def _product_groups(upload: dict[str, object]) -> list[dict[str, object]]:
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    product_column = columns["product_name"]
    reviewed_rows = upload.get("reviewed_product_rows", set())
    assert isinstance(reviewed_rows, set)
    unique_products: dict[str, list[int]] = {}
    for index, value in frame[product_column].items():
        if int(index) in reviewed_rows:
            continue
        name = str(value).strip()
        if not name:
            continue
        unique_products.setdefault(name, []).append(int(index))

    keys = list(unique_products)
    parent = list(range(len(keys)))

    def find(position: int) -> int:
        while parent[position] != position:
            parent[position] = parent[parent[position]]
            position = parent[position]
        return position

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    for left in range(len(keys)):
        left_key = _product_key(keys[left])
        if len(left_key) < 3:
            continue
        for right in range(left + 1, len(keys)):
            right_key = _product_key(keys[right])
            if len(right_key) < 3:
                continue
            same_base = left_key == right_key
            similarity = SequenceMatcher(None, left_key, right_key).ratio()
            if same_base or similarity >= 0.88:
                union(left, right)

    clusters: dict[int, list[int]] = {}
    for position in range(len(keys)):
        clusters.setdefault(find(position), []).append(position)

    groups: list[dict[str, object]] = []
    for positions in clusters.values():
        variations = [keys[position] for position in positions]
        if len(variations) < 2:
            continue
        row_ids = [
            row_id
            for position in positions
            for row_id in unique_products[keys[position]]
        ]
        suggested = min(variations, key=lambda name: (sum(character.isdigit() for character in name), len(name)))
        groups.append(
            {
                "group_id": f"product-{min(row_ids)}",
                "row_ids": row_ids,
                "standard_name": suggested,
                "variations": variations,
                "record_count": len(row_ids),
            }
        )
    return groups


@router.post("/dsg")
async def upload_dsg_dataset(file: UploadFile = File(...)) -> dict[str, object]:
    filename = Path(file.filename or "").name
    extension = Path(filename).suffix.lower()

    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Unsupported file type. Upload a CSV, XLSX, or XLS file.",
        )

    content = await file.read(MAX_FILE_SIZE + 1)
    await file.close()
    if not content:
        raise HTTPException(status_code=422, detail="The uploaded file is empty.")
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="The file exceeds the 50 MB upload limit.")
    dataset_hash = hashlib.sha256(content).hexdigest()
    with SessionLocal() as database:
        duplicate = (
            database.query(UploadHistory)
            .filter(UploadHistory.dataset_hash == dataset_hash)
            .first()
        )
        if duplicate:
            raise HTTPException(
                status_code=409,
                detail=f"This DSG dataset was already uploaded. Dataset ID: {duplicate.upload_id}.",
            )
    frame = _read_dataset(content, extension)
    if frame.empty:
        raise HTTPException(status_code=422, detail="The dataset contains no records.")

    columns = _validate_columns(frame)
    category_column = columns["category"]
    frame = frame.copy()
    frame.index = range(len(frame.index))
    frame[category_column] = frame[category_column].apply(
        lambda value: CATEGORY_MAPPING.get(str(value).strip().casefold(), value)
    )
    upload_id = str(uuid4())
    upload = {
        "frame": frame,
        "resolved_columns": columns,
        "file_name": filename,
        "channel": "DSG",
        "dataset_hash": dataset_hash,
        "uploaded_at": datetime.now(timezone.utc),
        "uploaded_by": "Admin User",
        "reviewed_product_rows": set(),
        "upload_id": upload_id,
    }
    with SessionLocal() as database:
        database.add(UploadHistory(
            upload_id=upload_id,
            dataset_hash=dataset_hash,
            file_name=filename,
            channel="DSG",
            uploaded_at=upload["uploaded_at"],
            uploaded_by="Admin User",
            total_records=len(frame.index),
            upload_status="Reviewing",
        ))
        database.commit()
    _save_upload(upload)
    review_rows = _review_rows(upload)
    product_groups = _product_groups(upload)

    return {
        "upload_id": upload_id,
        "file_name": filename,
        "channel": "DSG",
        "total_records": len(frame.index),
        "columns": list(map(str, frame.columns)),
        "resolved_columns": columns,
        "next_step": "category_review",
        "category_review_count": len(review_rows),
        "product_review_count": len(product_groups),
        "required_reviews": {
            "category": bool(review_rows),
            "product": bool(product_groups),
        },
        "status": "validated",
    }


@router.get("/dsg/{upload_id}/category-review")
def get_category_review(upload_id: str) -> dict[str, object]:
    upload = _get_upload(upload_id)
    rows = _review_rows(upload)
    return {
        "upload_id": upload_id,
        "records": rows,
        "remaining": len(rows),
        "completed": not rows,
        "standard_categories": STANDARD_CATEGORIES,
    }


@router.patch("/dsg/{upload_id}/category-review/{row_id}")
def update_category(upload_id: str, row_id: int, update: CategoryUpdate) -> dict[str, object]:
    upload = _get_upload(upload_id)
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    if row_id not in frame.index:
        raise HTTPException(status_code=404, detail="Review record not found.")
    current_category = str(frame.at[row_id, columns["category"]]).strip()
    if current_category.casefold() == "combo":
        raise HTTPException(status_code=422, detail="Combo records must be split into at least two parts.")
    frame.at[row_id, columns["category"]] = update.category
    _save_upload(upload)
    rows = _review_rows(upload)
    return {"updated": True, "remaining": len(rows), "completed": not rows}


@router.post("/dsg/{upload_id}/category-review/{row_id}/split")
def split_combo(upload_id: str, row_id: int, update: ComboUpdate) -> dict[str, object]:
    upload = _get_upload(upload_id)
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    if row_id not in frame.index:
        raise HTTPException(status_code=404, detail="Combo record not found.")
    if str(frame.at[row_id, columns["category"]]).strip().casefold() != "combo":
        raise HTTPException(status_code=422, detail="Only Combo records can be split.")
    try:
        original_amount = float(frame.at[row_id, columns["amount"]])
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="The Combo amount must be numeric before it can be split.") from exc
    split_total = sum(part.amount for part in update.parts)
    if abs(split_total - original_amount) > 0.01:
        raise HTTPException(
            status_code=422,
            detail=f"Split total ({split_total:.2f}) must equal the original amount ({original_amount:.2f}).",
        )

    original = frame.loc[row_id].copy()
    frame.drop(index=row_id, inplace=True)
    next_index = int(max(frame.index, default=-1)) + 1
    for offset, part in enumerate(update.parts):
        new_row = original.copy()
        new_row[columns["category"]] = part.category
        new_row[columns["amount"]] = part.amount
        frame.loc[next_index + offset] = new_row
    _save_upload(upload)
    rows = _review_rows(upload)
    return {"updated": True, "remaining": len(rows), "completed": not rows}


@router.get("/dsg/{upload_id}/product-review")
def get_product_review(upload_id: str) -> dict[str, object]:
    upload = _get_upload(upload_id)
    category_rows = _review_rows(upload)
    if category_rows:
        raise HTTPException(
            status_code=409,
            detail="Complete Category Review before opening Product Review.",
        )
    groups = _product_groups(upload)
    return {
        "upload_id": upload_id,
        "groups": groups,
        "remaining": len(groups),
        "completed": not groups,
    }


@router.patch("/dsg/{upload_id}/product-review/{group_id}")
def update_product_name(
    upload_id: str,
    group_id: str,
    update: ProductUpdate,
) -> dict[str, object]:
    upload = _get_upload(upload_id)
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    group = next(
        (item for item in _product_groups(upload) if item["group_id"] == group_id),
        None,
    )
    if group is None:
        raise HTTPException(status_code=404, detail="Product review group not found.")
    expected_variations = set(group["variations"])
    submitted_variations = {mapping.original_name for mapping in update.mappings}
    if submitted_variations != expected_variations:
        raise HTTPException(
            status_code=422,
            detail="Provide a Standard Product Name for every detected variation.",
        )
    product_column = columns["product_name"]
    updated_row_ids: set[int] = set()
    group_row_ids = set(int(row_id) for row_id in group["row_ids"])
    for mapping in update.mappings:
        standard_name = mapping.standard_name.strip()
        if not standard_name:
            raise HTTPException(status_code=422, detail="Standard Product Name cannot be empty.")
        matching_rows = [
            index
            for index in group_row_ids
            if str(frame.at[index, product_column]).strip() == mapping.original_name
        ]
        updated_row_ids.update(int(index) for index in matching_rows)
        frame.loc[matching_rows, product_column] = standard_name
    reviewed_rows = upload.get("reviewed_product_rows")
    assert isinstance(reviewed_rows, set)
    reviewed_rows.update(group_row_ids)
    _save_upload(upload)
    groups = _product_groups(upload)
    return {
        "updated": True,
        "updated_records": len(updated_row_ids),
        "remaining": len(groups),
        "completed": not groups,
    }


@router.post("/dsg/{upload_id}/complete")
def complete_dsg_upload(upload_id: str) -> dict[str, object]:
    upload = _get_upload(upload_id)
    if _review_rows(upload):
        raise HTTPException(status_code=409, detail="Complete Category Review before saving the dataset.")
    if _product_groups(upload):
        raise HTTPException(status_code=409, detail="Complete Product Review before saving the dataset.")
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)

    with SessionLocal() as database:
        history = database.query(UploadHistory).filter_by(upload_id=upload_id, channel="DSG").first()
        if history is None:
            raise HTTPException(status_code=404, detail="Upload session not found. Please upload the file again.")
        history.total_records = len(frame.index)
        history.upload_status = "Completed"
        for dataset_row in database.query(DSGDatasetRow).filter_by(upload_id=upload_id).all():
            row_data = dict(dataset_row.row_data)
            row_data.pop(PRODUCT_REVIEWED_MARKER, None)
            dataset_row.row_data = row_data
        try:
            database.commit()
        except IntegrityError as exc:
            database.rollback()
            raise HTTPException(
                status_code=409,
                detail="This DSG dataset already exists in PostgreSQL.",
            ) from exc
        except SQLAlchemyError as exc:
            database.rollback()
            raise HTTPException(
                status_code=503,
                detail="The reviewed dataset could not be saved to PostgreSQL.",
            ) from exc
    return {
        "upload_id": upload_id,
        "file_name": upload["file_name"],
        "channel": "DSG",
        "total_records": len(frame.index),
        "status": "Completed",
    }


@router.get("/history")
def get_upload_history(channel: str | None = None) -> dict[str, object]:
    with SessionLocal() as database:
        query = database.query(UploadHistory)
        if channel:
            normalised_channel = channel.upper()
            if normalised_channel not in {"DSG", "SFH", "DIRECT SALES"}:
                raise HTTPException(status_code=422, detail="Unsupported Upload History channel.")
            query = query.filter(UploadHistory.channel == normalised_channel)
        uploads = query.order_by(UploadHistory.uploaded_at.desc()).all()
        return {
            "records": [
                {
                    "upload_id": item.upload_id,
                    "file_name": item.file_name,
                    "channel": item.channel,
                    "uploaded_at": item.uploaded_at.isoformat(),
                    "uploaded_by": item.uploaded_by,
                    "total_records": item.total_records,
                    "upload_status": item.upload_status,
                }
                for item in uploads
            ]
        }


@router.delete("/history/{upload_id}")
def delete_upload_history(upload_id: str) -> dict[str, object]:
    with SessionLocal() as database:
        history = database.get(UploadHistory, upload_id)
        if history is None:
            raise HTTPException(status_code=404, detail="Upload History record not found.")
        database.delete(history)
        try:
            database.commit()
        except SQLAlchemyError as exc:
            database.rollback()
            raise HTTPException(status_code=503, detail="The dataset could not be deleted from PostgreSQL.") from exc
    return {"deleted": True, "upload_id": upload_id}
