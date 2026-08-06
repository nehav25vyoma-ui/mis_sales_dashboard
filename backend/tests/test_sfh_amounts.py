from app.calculations.amounts import (
    sfh_amount_from_record,
    sfh_amount_from_values,
    sfh_is_inr_currency,
    whole_number,
)


def test_only_rupee_symbol_identifies_inr() -> None:
    assert sfh_is_inr_currency("₹")
    assert sfh_is_inr_currency("₹1,250")
    assert sfh_is_inr_currency("₹500.00")
    assert not sfh_is_inr_currency("INR")
    assert not sfh_is_inr_currency("USD")
    assert not sfh_is_inr_currency("")
    assert not sfh_is_inr_currency(None)


def test_sfh_amount_uses_without_tax_total_for_rupee_records() -> None:
    assert sfh_amount_from_values("₹", 1250, 900) == 1250


def test_sfh_amount_uses_earnings_for_every_non_rupee_record() -> None:
    for currency in ("INR", "USD", "EUR", "GBP", "AUD", "", None):
        assert sfh_amount_from_values(currency, 1250, 900) == 900


def test_sfh_record_lookup_uses_normalised_headers() -> None:
    record = {
        "Currency": "INR",
        "Without Tax Total": 1250,
        "Earnings": 900,
    }
    assert sfh_amount_from_record(record) == 900


def test_whole_number_matches_visual_half_up_rounding() -> None:
    assert whole_number(100.49) == 100
    assert whole_number(100.5) == 101
