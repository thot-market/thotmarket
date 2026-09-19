"""Fail-closed TDX quote, key, measurement, and role verification."""
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile


def _canon(value): return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _qvl(binary, command, quote):
    if not os.path.isabs(binary): raise ValueError("dcap_qvl_path_not_absolute")
    with tempfile.NamedTemporaryFile("w", suffix=".quote") as stream:
        stream.write(quote); stream.flush()
        run = subprocess.run([binary, command, "--hex", stream.name], capture_output=True, text=True, timeout=60)
    if run.returncode: raise ValueError("tdx_quote_invalid")
    try: return json.loads(run.stdout)
    except json.JSONDecodeError: raise ValueError("tdx_quote_decode_invalid")


def _td(report):
    report = report.get("report", {})
    return report.get("TD15", {}).get("base", report.get("TD10", report))


def _digest(event):
    if event.get("event_type") == 0x08000001:
        return hashlib.sha384(int(event["event_type"]).to_bytes(4, "little") + b":" +
            (event.get("event") or "").encode() + b":" + bytes.fromhex(event.get("event_payload") or "")).digest()
    return bytes.fromhex(event["digest"]) if event.get("digest") else None


def verify_attested_key(attestation, pubkey, role, qvl="/usr/local/bin/dcap-qvl", measurements=None, measurements_path=None):
    if not isinstance(attestation, dict) or attestation.get("mode") != "tdx": raise ValueError("attestation_not_tdx")
    _qvl(qvl, "verify", attestation.get("quote", ""))
    decoded = _qvl(qvl, "decode", attestation.get("quote", "")); td = _td(decoded)
    statement = attestation.get("statement")
    if (not isinstance(statement, dict) or statement.get("purpose") != "trace-vault.report_data.v1"
            or statement.get("vault_pubkey") != pubkey): raise ValueError("attested_key_mismatch")
    if (td.get("report_data", "") or "")[:64] != hashlib.sha256(_canon(statement)).hexdigest():
        raise ValueError("quote_report_data_mismatch")
    log = attestation.get("event_log")
    if isinstance(log, str): log = json.loads(log)
    if not isinstance(log, list): raise ValueError("missing_event_log")
    replay = {i: b"\0" * 48 for i in range(4)}
    for event in log:
        index, digest = event.get("imr"), _digest(event)
        if index in replay and digest is not None: replay[index] = hashlib.sha384(replay[index] + (digest + b"\0" * 48)[:48]).digest()
    if any(replay[i].hex() != td.get(f"rt_mr{i}") for i in range(4)): raise ValueError("measurement_replay_mismatch")
    payloads = {}
    for event in log:
        # Only dstack runtime events extended into RTMR3 cryptographically bind name+payload.
        if event.get("imr") == 3 and event.get("event_type") == 0x08000001 and event.get("event"):
            if event["event"] in payloads: raise ValueError("duplicate_identity_event")
            payloads[event["event"]] = event.get("event_payload")
    if measurements is None:
        inline = os.environ.get("TV_MEASUREMENTS_JSON")
        if inline and not measurements_path: pins = json.loads(inline)
        else:
            path = pathlib.Path(measurements_path or os.environ.get("TV_MEASUREMENTS_FILE") or
                                pathlib.Path(__file__).with_name("measurements.json"))
            pins = json.loads(path.read_text())
    else: pins = measurements
    pin = pins.get("instances", {}).get(payloads.get("app-id"))
    if not pin or not str(pin.get("role", "")).startswith(role): raise ValueError("unapproved_attested_role")
    if payloads.get("compose-hash") != pin.get("compose_hash") or payloads.get("os-image-hash") != pin.get("os_image_hash"):
        raise ValueError("unapproved_measurement")
    return True
