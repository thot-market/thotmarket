YOUR PRIVATE THOT CAPTURE

This folder contains plaintext model requests and responses. Keep it private.
The original evidence is in export.json and parts/. Nothing requires a THOT account
or a model subscription to verify these files.

1. Install Node.js 24+ if necessary.
2. Run: node verify.mjs

VALID means the bytes and signature match the supplied signing key. Hardware is
UNVERIFIED until you request the separate hardware checks. A signed prefix does
not prove that every conversation turn or tool action was captured.

Optional offline hardware verification:
Install requirements.txt in your own Python environment with:
  pip install --require-hashes --only-binary=:all: -r requirements.txt
Then use an independently trusted recorder policy and signed collateral:
  node verify.mjs . --python /absolute/venv/bin/python --policy /trusted/policy.json --collateral /trusted/collateral.json

The policy must be outside this export. Signed collateral may travel inside it as
collateral.json; the --collateral argument is then optional. Default verification time is now.
--at UNIX_SECONDS evaluates historical validity, not proof of recording time.
--allow-historical permits historical compose hashes in your trusted policy.
A missing dependency, expired collateral or unapproved recorder must not count as
verified hardware. Exit 2 preserves valid integrity while reporting that failure.

For a file supplied by someone else, use your separately trusted verifier rather
than executing the sender's code. Moving the data files does not change the proof.
