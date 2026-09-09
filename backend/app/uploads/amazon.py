from datetime import datetime, timezone
import hashlib
from pathlib import Path
from uuid import uuid4

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.database.database import SessionLocal
from app.database.models import AmazonDatasetRow, UploadHistory
from app.uploads.dsg import (
    ALLOWED_EXTENSIONS,
    MAX_FILE_SIZE,
    ProductUpdate,
    _json_value,
    _normalise_header,
    _product_groups,
    _read_dataset,
)

router = APIRouter(prefix="/api/uploads", tags=["uploads"])
AMAZON_UPLOAD_STORE: dict[str, dict[str, object]] = {}


def _get_upload(upload_id: str) -> dict[str, object]:
    upload = AMAZON_UPLOAD_STORE.get(upload_id)
    if upload is None:
        raise HTTPException(status_code=404, detail="Amazon upload session not found. Please upload the file again.")
    return upload


@router.post("/amazon")
async def upload_amazon_dataset(file: UploadFile = File(...)) -> dict[str, object]:
    filename = Path(file.filename or "").name
    extension = Path(filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Unsupported file type. Upload a CSV, XLSX, or XLS file.")
    content = await file.read(MAX_FILE_SIZE + 1)
    await file.close()
    if not content:
        raise HTTPException(status_code=422, detail="The uploaded Amazon file is empty.")
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="The file exceeds the 50 MB upload limit.")

    dataset_hash = hashlib.sha256(content).hexdigest()
    with SessionLocal() as database:
        duplicate = database.query(UploadHistory).filter_by(dataset_hash=dataset_hash).first()
        if duplicate:
            raise HTTPException(status_code=409, detail=f"This dataset was already uploaded. Dataset ID: {duplicate.upload_id}.")
    existing = next(
        (
            (existing_id, item)
            for existing_id, item in AMAZON_UPLOAD_STORE.items()
            if item.get("dataset_hash") == dataset_hash
        ),
        None,
    )
    if existing:
        existing_id, existing_upload = existing
        existing_frame = existing_upload["frame"]
        assert isinstance(existing_frame, pd.DataFrame)
        groups = _product_groups(existing_upload)
        return {
            "upload_id": existing_id,
            "file_name": existing_upload["file_name"],
            "channel": "AMAZON",
            "total_records": len(existing_frame.index),
            "category_review_count": 0,
            "product_review_count": len(groups),
            "required_reviews": {"category": False, "product": bool(groups)},
            "next_step": "product_review" if groups else "save_dataset",
            "status": "reviewing",
            "resumed": True,
        }

    frame = _read_dataset(content, extension)
    if frame.empty:
        raise HTTPException(status_code=422, detail="The Amazon dataset contains no records.")
    # Amazon exports use hyphenated headers (for example product-name).
    available = {_normalise_header(column).replace("-", " "): str(column) for column in frame.columns}
    required = {
        "product_name": "product name",
        "currency": "currency",
        "amount": "item price",
        "state": "ship state",
    }
    resolved = {key: available.get(header) for key, header in required.items()}
    missing = [header.replace(" ", "-") for key, header in required.items() if resolved[key] is None]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"This file is not a valid Amazon dataset. Missing mandatory Amazon columns: {', '.join(missing)}.",
        )

    frame = frame.copy()
    item_prices = pd.to_numeric(
        frame[resolved["amount"]].astype(str).str.replace(",", "", regex=False),
        errors="coerce",
    )
    frame = frame.loc[item_prices.ne(0) & item_prices.notna()].copy()
    if frame.empty:
        raise HTTPException(
            status_code=422,
            detail="The Amazon dataset contains no records with a non-zero item-price.",
        )
    frame.index = range(len(frame.index))
    frame["Category"] = "Books"
    resolved["category"] = "Category"
    upload_id = str(uuid4())
    upload: dict[str, object] = {
        "frame": frame,
        "resolved_columns": resolved,
        "file_name": filename,
        "channel": "AMAZON",
        "dataset_hash": dataset_hash,
        "uploaded_at": datetime.now(timezone.utc),
        "uploaded_by": "Admin User",
        "reviewed_product_rows": set(),
    }
    AMAZON_UPLOAD_STORE[upload_id] = upload
    groups = _product_groups(upload)
    return {
        "upload_id": upload_id,
        "file_name": filename,
        "channel": "AMAZON",
        "total_records": len(frame.index),
        "category_review_count": 0,
        "product_review_count": len(groups),
        "required_reviews": {"category": False, "product": bool(groups)},
        "next_step": "product_review" if groups else "save_dataset",
        "status": "validated",
    }


@router.get("/amazon/{upload_id}/product-review")
def get_product_review(upload_id: str) -> dict[str, object]:
    groups = _product_groups(_get_upload(upload_id))
    return {"upload_id": upload_id, "groups": groups, "remaining": len(groups), "completed": not groups}


@router.delete("/amazon/{upload_id}")
def discard_upload(upload_id: str) -> dict[str, object]:
    if AMAZON_UPLOAD_STORE.pop(upload_id, None) is None:
        raise HTTPException(status_code=404, detail="Amazon upload session not found.")
    return {"deleted": True, "upload_id": upload_id}


@router.patch("/amazon/{upload_id}/product-review/{group_id}")
def update_product_name(upload_id: str, group_id: str, update: ProductUpdate) -> dict[str, object]:
    upload = _get_upload(upload_id)
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    group = next((item for item in _product_groups(upload) if item["group_id"] == group_id), None)
    if group is None:
        raise HTTPException(status_code=404, detail="Amazon Product Review group not found.")
    expected = set(group["variations"])
    if {mapping.original_name for mapping in update.mappings} != expected:
        raise HTTPException(status_code=422, detail="Provide a Standard Product Name for every detected product-name variation.")
    product_column = columns["product_name"]
    group_rows = set(int(row_id) for row_id in group["row_ids"])
    for mapping in update.mappings:
        matching = [index for index in group_rows if str(frame.at[index, product_column]).strip() == mapping.original_name]
        frame.loc[matching, product_column] = mapping.standard_name.strip()
    reviewed = upload["reviewed_product_rows"]
    assert isinstance(reviewed, set)
    reviewed.update(group_rows)
    groups = _product_groups(upload)
    return {"updated": True, "remaining": len(groups), "completed": not groups}


@router.post("/amazon/{upload_id}/complete")
def complete_upload(upload_id: str) -> dict[str, object]:
    upload = _get_upload(upload_id)
    if _product_groups(upload):
        raise HTTPException(status_code=409, detail="Complete Amazon Product Review before saving the dataset.")
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    with SessionLocal() as database:
        database.add(UploadHistory(
            upload_id=upload_id, dataset_hash=str(upload["dataset_hash"]), file_name=str(upload["file_name"]),
            channel="AMAZON", uploaded_at=upload["uploaded_at"], uploaded_by=str(upload["uploaded_by"]),
            total_records=len(frame.index), upload_status="Completed",
        ))
        for source_number, (_, row) in enumerate(frame.iterrows(), start=1):
            database.add(AmazonDatasetRow(
                upload_id=upload_id,
                source_row_number=source_number,
                product_name=str(_json_value(row[columns["product_name"]]) or ""),
                category="Books",
                amount=str(_json_value(row[columns["amount"]]) or ""),
                currency=str(_json_value(row[columns["currency"]]) or ""),
                state=str(_json_value(row[columns["state"]]) or ""),
                row_data={str(column): _json_value(row[column]) for column in frame.columns},
            ))
        try:
            database.commit()
        except IntegrityError as exc:
            database.rollback()
            raise HTTPException(status_code=409, detail="This Amazon dataset already exists in PostgreSQL.") from exc
        except SQLAlchemyError as exc:
            database.rollback()
            raise HTTPException(status_code=503, detail="The Amazon dataset could not be saved to PostgreSQL.") from exc
    AMAZON_UPLOAD_STORE.pop(upload_id, None)
    return {"upload_id": upload_id, "file_name": upload["file_name"], "channel": "AMAZON", "total_records": len(frame.index), "status": "Completed"}
