from decimal import Decimal, ROUND_HALF_UP
from typing import Any


def normalise_header(value: object) -> str:
    return " ".join(str(value).strip().casefold().replace("_", " ").split())


def find_column(columns: list[object], aliases: tuple[str, ...]) -> str | None:
    available = {normalise_header(column): str(column) for column in columns}
    return next((available[alias] for alias in aliases if alias in available), None)


def whole_number(value: object) -> int:
    """Round displayed values half-up, matching positive JavaScript Math.round."""
    try:
        return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (ValueError, TypeError):
        return 0


def dsg_amount_column(columns: list[object]) -> str | None:
    return find_column(
        columns,
        (
            "item cost × quantity",
            "item cost x quantity",
            "item cost*quantity",
            "item cost * quantity",
        ),
    )


def sfh_is_inr_currency(currency: object) -> bool:
    """Return True only when the SFH Currency value contains the ₹ symbol."""
    return "\u20b9" in str(currency)


def sfh_amount_from_values(
    currency: object,
    without_tax_total: object,
    earnings: object,
) -> object:
    # Text such as "INR" is intentionally non-INR for SFH. Only ₹ qualifies.
    return without_tax_total if sfh_is_inr_currency(currency) else earnings


def sfh_amount_from_record(record: dict[str, Any]) -> object:
    values = {normalise_header(key): value for key, value in record.items()}
    return sfh_amount_from_values(
        values.get("currency"),
        values.get("without tax total"),
        values.get("earnings"),
    )
