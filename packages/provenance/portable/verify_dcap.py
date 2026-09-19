"""Bounded, offline Intel-root verification. Never fetch collateral or emit platform IDs.

The Node caller supplies verification time from its operator-controlled clock.
Historical fixture clocks prove historical verification only, not current freshness.
"""
import hashlib
import importlib.metadata
import json
import sys


def main():
    import dcap_qvl

    if importlib.metadata.version("dcap-qvl") != "0.6.1":
        raise ValueError("UNPINNED_DCAP_LIBRARY")
    raw_input = sys.stdin.buffer.read(2_000_001)
    if len(raw_input) > 2_000_000:
        raise ValueError("DCAP_INPUT_LIMIT")
    obj = json.loads(raw_input)
    if set(obj) != {"protocol", "quote_hex", "collateral", "verification_time_seconds", "platform_policy"} or obj["protocol"] != "thot.dcap-offline/1":
        raise ValueError("INVALID_DCAP_INPUT")
    now = obj["verification_time_seconds"]
    if type(now) is not int or now < 0 or now > 253402300799:
        raise ValueError("INVALID_DCAP_CLOCK")
    quote = bytes.fromhex(obj["quote_hex"])
    if len(quote) < 636 or len(quote) > 100_000:
        raise ValueError("INVALID_DCAP_QUOTE")
    collateral = dcap_qvl.QuoteCollateralV3.from_json(json.dumps(obj["collateral"]))
    flags = obj["platform_policy"]
    if set(flags) != {"allow_dynamic_platform", "allow_cached_keys", "allow_smt"} or any(type(v) is not bool for v in flags.values()):
        raise ValueError("INVALID_DCAP_POLICY")
    policy = dcap_qvl.QuotePolicy.strict(now).allow_dynamic_platform(flags["allow_dynamic_platform"]).allow_cached_keys(flags["allow_cached_keys"]).allow_smt(flags["allow_smt"])
    # Uses the compiled library's production Intel root. No root override or claims-only mode.
    claims = dcap_qvl.QuoteVerifier().verify_with_policy(
        quote, collateral, now, policy
    )
    verified = json.loads(claims.to_json())
    report = verified["report"].get("TD10")
    if verified["tee_type"] != 129 or report is None or verified["tcb"]["status"] != "UpToDate":
        raise ValueError("UNSUPPORTED_DCAP_REPORT")
    print(json.dumps({
        "protocol": "thot.dcap-offline/1", "verified": True,
        "library_version": "0.6.1", "quote_hash": hashlib.sha256(quote).hexdigest(),
        "verification_time_seconds": now, "status": verified["tcb"]["status"], "platform_policy": flags,
        "advisory_ids": verified["tcb"]["advisory_ids"],
        "earliest_expiration_seconds": verified["earliest_expiration_date"],
        "report_data": report["report_data"],
        "debug": bool(int.from_bytes(bytes.fromhex(report["td_attributes"]), "little") & 1),
        "measurements": {"mrtd": report["mr_td"], **{f"rtmr{i}": report[f"rt_mr{i}"] for i in range(4)}},
    }, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except ImportError:
        print('{"error":"DCAP_LIBRARY_UNAVAILABLE"}')
        sys.exit(1)
    except Exception:
        # Exceptions may include raw quote, cert, or collateral; do not leak them to logs.
        print('{"error":"DCAP_VERIFICATION_FAILED"}')
        sys.exit(1)
