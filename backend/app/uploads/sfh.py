from datetime import datetime, timezone
import hashlib
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.database.database import SessionLocal
from app.database.models import SFHDatasetRow, UploadHistory
from app.calculations.amounts import find_column, sfh_amount_from_values
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
SFH_UPLOAD_STORE: dict[str, dict[str, object]] = {}


def _get_sfh_upload(upload_id: str) -> dict[str, object]:
    upload = SFH_UPLOAD_STORE.get(upload_id)
    if upload is None:
        raise HTTPException(status_code=404, detail="SFH upload session not found. Please upload the file again.")
    return upload


@router.post("/sfh")
async def upload_sfh_dataset(file: UploadFile = File(...)) -> dict[str, object]:
    filename = Path(file.filename or "").name
    extension = Path(filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Unsupported file type. Upload a CSV, XLSX, or XLS file.")
    content = await file.read(MAX_FILE_SIZE + 1)
    await file.close()
    if not content:
        raise HTTPException(status_code=422, detail="The uploaded SFH file is empty.")
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="The file exceeds the 50 MB upload limit.")

    dataset_hash = hashlib.sha256(content).hexdigest()
    with SessionLocal() as database:
        duplicate = database.query(UploadHistory).filter_by(dataset_hash=dataset_hash).first()
        if duplicate:
            raise HTTPException(
                status_code=409,
                detail=f"This dataset was already uploaded. Dataset ID: {duplicate.upload_id}.",
            )
    if any(item.get("dataset_hash") == dataset_hash for item in SFH_UPLOAD_STORE.values()):
        raise HTTPException(status_code=409, detail="This SFH dataset is already being reviewed.")

    frame = _read_dataset(content, extension)
    if frame.empty:
        raise HTTPException(status_code=422, detail="The SFH dataset contains no records.")
    available = {_normalise_header(column): str(column) for column in frame.columns}
    course_column = available.get("course")
    currency_column = find_column(list(frame.columns), ("currency",))
    without_tax_column = find_column(list(frame.columns), ("without tax total",))
    earnings_column = find_column(list(frame.columns), ("earnings",))
    missing = [
        label
        for label, column in (
            ("Course", course_column),
            ("Currency", currency_column),
            ("Without Tax Total", without_tax_column),
            ("Earnings", earnings_column),
        )
        if column is None
    ]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"This file is not a valid SFH dataset. Missing mandatory SFH columns: {', '.join(missing)}.",
        )
    assert course_column is not None
    assert currency_column is not None
    assert without_tax_column is not None
    assert earnings_column is not None

    frame = frame.copy()
    frame.index = range(len(frame.index))
    category_column = available.get("category")
    if category_column is None:
        category_column = "Category"
        frame[category_column] = "Web Version"
    else:
        frame[category_column] = "Web Version"
    frame["Amount"] = frame.apply(
        lambda row: sfh_amount_from_values(
            row[currency_column],
            row[without_tax_column],
            row[earnings_column],
        ),
        axis=1,
    )

    upload_id = str(uuid4())
    upload: dict[str, object] = {
        "frame": frame,
        "resolved_columns": {
            "product_name": course_column,
            "course": course_column,
            "category": category_column,
            "currency": currency_column,
            "without_tax_total": without_tax_column,
            "earnings": earnings_column,
            "amount": "Amount",
        },
        "file_name": filename,
        "channel": "SFH",
        "dataset_hash": dataset_hash,
        "uploaded_at": datetime.now(timezone.utc),
        "uploaded_by": "Admin User",
        "reviewed_product_rows": set(),
    }
    SFH_UPLOAD_STORE[upload_id] = upload
    groups = _product_groups(upload)
    return {
        "upload_id": upload_id,
        "file_name": filename,
        "channel": "SFH",
        "total_records": len(frame.index),
        "category_review_count": 0,
        "product_review_count": len(groups),
        "required_reviews": {"category": False, "product": bool(groups)},
        "next_step": "product_review" if groups else "save_dataset",
        "status": "validated",
    }


@router.get("/sfh/{upload_id}/product-review")
def get_sfh_product_review(upload_id: str) -> dict[str, object]:
    groups = _product_groups(_get_sfh_upload(upload_id))
    return {
        "upload_id": upload_id,
        "groups": groups,
        "remaining": len(groups),
        "completed": not groups,
    }


@router.patch("/sfh/{upload_id}/product-review/{group_id}")
def update_sfh_product_name(
    upload_id: str,
    group_id: str,
    update: ProductUpdate,
) -> dict[str, object]:
    upload = _get_sfh_upload(upload_id)
    frame = upload["frame"]
    columns = upload["resolved_columns"]
    assert isinstance(frame, pd.DataFrame)
    assert isinstance(columns, dict)
    group = next((item for item in _product_groups(upload) if item["group_id"] == group_id), None)
    if group is None:
        raise HTTPException(status_code=404, detail="SFH Product Review group not found.")
    expected = set(group["variations"])
    if {mapping.original_name for mapping in update.mappings} != expected:
        raise HTTPException(status_code=422, detail="Provide a Standard Product Name for every detected Course variation.")

    course_column = columns["course"]
    group_rows = set(int(row_id) for row_id in group["row_ids"])
    updated_rows: set[int] = set()
    for mapping in update.mappings:
        standard_name = mapping.standard_name.strip()
        matching = [
            index for index in group_rows
            if str(frame.at[index, course_column]).strip() == mapping.original_name
        ]
        frame.loc[matching, course_column] = standard_name
        updated_rows.update(matching)
    reviewed = upload["reviewed_product_rows"]
    assert isinstance(reviewed, set)
    reviewed.update(group_rows)
    groups = _product_groups(upload)
    return {
        "updated": True,
        "updated_records": len(updated_rows),
        "remaining": len(groups),
        "completed": not groups,
    }


@router.post("/sfh/{upload_id}/complete")
def complete_sfh_upload(upload_id: str) -> dict[str, object]:
    upload = _get_sfh_upload(upload_id)
    if _product_groups(upload):
        raise HTTPException(status_code=409, detail="Complete SFH Product Review before saving the dataset.")
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
                channel="SFH",
                uploaded_at=upload["uploaded_at"],
                uploaded_by=str(upload["uploaded_by"]),
                total_records=len(frame.index),
                upload_status="Completed",
            )
        )
        for source_number, (_, row) in enumerate(frame.iterrows(), start=1):
            course = str(_json_value(row[columns["course"]]) or "")
            database.add(
                SFHDatasetRow(
                    upload_id=upload_id,
                    source_row_number=source_number,
                    course=course,
                    product_name=course,
                    category="Web Version",
                    row_data={str(column): _json_value(row[column]) for column in frame.columns},
                )
            )
        try:
            database.commit()
        except IntegrityError as exc:
            database.rollback()
            raise HTTPException(status_code=409, detail="This SFH dataset already exists in PostgreSQL.") from exc
        except SQLAlchemyError as exc:
            database.rollback()
            raise HTTPException(status_code=503, detail="The SFH dataset could not be saved to PostgreSQL.") from exc
    SFH_UPLOAD_STORE.pop(upload_id, None)
    return {
        "upload_id": upload_id,
        "file_name": upload["file_name"],
        "channel": "SFH",
        "total_records": len(frame.index),
        "status": "Completed",
    }
