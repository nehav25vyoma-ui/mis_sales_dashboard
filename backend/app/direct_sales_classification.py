"""Canonical Direct Sales channel classification rules."""

from collections.abc import Iterable
import re


DIRECT_SALES_CLASSIFICATIONS = (
    "Stall",
    "Retail",
    "Call",
    "Bulk",
    "Language Lab",
    "Course Promotion",
    "In Office",
)


def classify_direct_sale(text_values: Iterable[object], product_quantity: object, *, customer_name: object = None, private_notes: object = None) -> str:
    """Classify one product row using the required, mutually exclusive priority."""
    text = " ".join(
        str(value).strip().casefold()
        for value in text_values
        if value is not None and str(value).strip()
    )
    notes = " ".join(str(private_notes or "").casefold().split())

    retail_customer = " ".join(str(customer_name or "").casefold().split()) in {
        "vendant book house", "vedanta book house", "vedantha book house",
    }
    is_call = bool(re.search(r"\b(?:call|phone)\b", notes))
    is_bulk = bool(re.search(r"\bbulk\b", notes))
    # Keep precisely the existing Language Lab eligibility; only the six
    # requested subtypes switch to invoice-field matching.
    if ("language lab" in text and "stall" not in text
            and not any(name in text for name in ("vendant", "vedanta", "vedantha"))
            and not retail_customer and not is_call and not is_bulk):
        return "Language Lab"
    if re.search(r"\bstall\b", notes):
        return "Stall"
    if re.search(r"\b(?:vendant|vedanta|vedantha)\b", notes) or retail_customer:
        return "Retail"
    if is_call:
        return "Call"
    if re.search(r"\bin office\b", notes):
        return "In Office"
    if re.search(r"\bcourse promotion\b", notes):
        return "Course Promotion"
    if is_bulk:
        return "Bulk"
    return "In Office"
