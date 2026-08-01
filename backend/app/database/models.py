from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.database import Base


class UploadHistory(Base):
    __tablename__ = "upload_history"

    upload_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    dataset_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    file_name: Mapped[str] = mapped_column(String(500), nullable=False)
    channel: Mapped[str] = mapped_column(String(30), nullable=False, default="DSG", index=True)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    uploaded_by: Mapped[str] = mapped_column(String(200), nullable=False, default="Admin User")
    total_records: Mapped[int] = mapped_column(Integer, nullable=False)
    upload_status: Mapped[str] = mapped_column(String(30), nullable=False, default="Completed")

    rows: Mapped[list["DSGDatasetRow"]] = relationship(
        back_populates="upload",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    sfh_rows: Mapped[list["SFHDatasetRow"]] = relationship(
        back_populates="upload",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    direct_sales_rows: Mapped[list["DirectSalesDatasetRow"]] = relationship(
        back_populates="upload",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class DSGDatasetRow(Base):
    __tablename__ = "dsg_dataset_rows"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    upload_id: Mapped[str] = mapped_column(
        ForeignKey("upload_history.upload_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_row_number: Mapped[int] = mapped_column(Integer, nullable=False)
    order_number: Mapped[str | None] = mapped_column(String(255))
    product_name: Mapped[str | None] = mapped_column(String(500))
    category: Mapped[str | None] = mapped_column(String(100))
    amount: Mapped[str | None] = mapped_column(String(100))
    row_data: Mapped[dict] = mapped_column(JSON, nullable=False)

    upload: Mapped[UploadHistory] = relationship(back_populates="rows")


class SFHDatasetRow(Base):
    __tablename__ = "sfh_dataset_rows"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    upload_id: Mapped[str] = mapped_column(
        ForeignKey("upload_history.upload_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_row_number: Mapped[int] = mapped_column(Integer, nullable=False)
    course: Mapped[str | None] = mapped_column(String(500))
    product_name: Mapped[str | None] = mapped_column(String(500))
    category: Mapped[str | None] = mapped_column(String(100))
    row_data: Mapped[dict] = mapped_column(JSON, nullable=False)

    upload: Mapped[UploadHistory] = relationship(back_populates="sfh_rows")


class DirectSalesDatasetRow(Base):
    __tablename__ = "direct_sales_dataset_rows"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    upload_id: Mapped[str] = mapped_column(
        ForeignKey("upload_history.upload_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_row_number: Mapped[int] = mapped_column(Integer, nullable=False)
    order_number: Mapped[str | None] = mapped_column(String(255))
    product_name: Mapped[str | None] = mapped_column(String(500))
    category: Mapped[str | None] = mapped_column(String(100))
    amount: Mapped[str | None] = mapped_column(String(100))
    row_data: Mapped[dict] = mapped_column(JSON, nullable=False)

    upload: Mapped[UploadHistory] = relationship(back_populates="direct_sales_rows")
