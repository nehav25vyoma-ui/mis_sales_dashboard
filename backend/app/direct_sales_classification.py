"""Canonical Direct Sales channel classification rules."""

from collections.abc import Iterable


DIRECT_SALES_CLASSIFICATIONS = (
    "Stall",
    "Retail",
    "Call",
    "Bulk",
    "Language Lab",
    "Course Promotion",
    "In Office",
)


def classify_direct_sale(text_values: Iterable[object], product_quantity: object) -> str:
    """Classify one product row using the required, mutually exclusive priority."""
    text = " ".join(
        str(value).strip().casefold()
        for value in text_values
        if value is not None and str(value).strip()
    )

    if "stall" in text:
        return "Stall"
    if "vendant" in text:
        return "Retail"
    if "ph" in text or "call" in text:
        return "Call"
    try:
        if float(str(product_quantity).replace(",", "").strip()) > 10:
            return "Bulk"
    except (TypeError, ValueError):
        pass
    if "language lab" in text:
        return "Language Lab"
    if any(keyword in text for keyword in ("course", "grammer", "s101")):
        return "Course Promotion"
    return "In Office"
