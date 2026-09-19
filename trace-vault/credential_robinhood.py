"""Track B - Robinhood credential/outcome extractor (whitepaper C2, §5 narrow-predicate).

Equity /orders/ records carry instrument_id (uuid) but NO ticker; the symbol is resolved via
/instruments/{id}/ - the two-step resolve is the whole point. From one orders response we emit two
independently-provable, vault-key-signed statements:
  - controls_brokerage:true  (an /accounts/ response with an account_number exists)
  - traded:<SYMBOL>:within_<N>d  (a filled buy/sell of SYMBOL within N days of the trace timestamp)
The firewall: the signed output reveals ONLY the matched symbol + boolean/window. It never carries
the account number, quantities, prices, or any unrelated ticker. Missing/renamed source fields RAISE
(no fallbacks). Signing follows auction.py: canon(statement) signed by the attest vault key."""
import datetime as dt
import attest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

def _parse(ts): return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))

def resolve_symbol(order, instruments):
    return instruments[order["instrument_id"]]["symbol"]

def compute_traded(orders, instruments, symbol, trace_ts, n_days):
    """Pure recompute a third party can run over the delivered orders JSON: True iff some order is
    filled, side buy/sell, resolves to SYMBOL, and transacted within n_days of trace_ts."""
    t0 = _parse(trace_ts); win = dt.timedelta(days=n_days)
    for o in orders["results"]:
        if o["state"] != "filled" or o["side"] not in ("buy", "sell"):
            continue
        if o["instrument_id"] not in instruments:  # order for an instrument we did not witness; not this symbol
            continue
        if resolve_symbol(o, instruments) != symbol:
            continue
        if abs(_parse(o["last_transaction_at"]) - t0) <= win:
            return True
    return False

def _sign(stmt):
    return {**stmt, "attestation": attest.attestation(), "signature": attest.sign(attest.canon(stmt))}

def controls_brokerage_credential(accounts):
    if not any(a["account_number"] for a in accounts["results"]):
        raise ValueError("no account with an account_number in accounts response")
    stmt = {"purpose": "trace-vault.credential.v1", "claim": "controls_brokerage", "value": True,
            "vault_pubkey": attest.vault_pubkey()}
    return _sign(stmt)

def traded_outcome(orders, instruments, symbol, trace_ts, n_days):
    value = compute_traded(orders, instruments, symbol, trace_ts, n_days)
    stmt = {"purpose": "trace-vault.outcome.v1", "label": f"traded:{symbol}:within_{n_days}d",
            "symbol": symbol, "window_days": n_days, "value": value, "trace_ts": trace_ts,
            "vault_pubkey": attest.vault_pubkey()}
    return _sign(stmt)

def verify_signature(signed):
    """Raises cryptography.exceptions.InvalidSignature if the vault-key signature does not match."""
    stmt = {k: v for k, v in signed.items() if k not in ("attestation", "signature")}
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(signed["vault_pubkey"])).verify(
        bytes.fromhex(signed["signature"]), attest.canon(stmt))

def verify_outcome(signed, orders, instruments):
    """Third-party check: signature valid AND the label recomputed from delivered JSON == signed value."""
    verify_signature(signed)
    return compute_traded(orders, instruments, signed["symbol"], signed["trace_ts"],
                          signed["window_days"]) == signed["value"]
