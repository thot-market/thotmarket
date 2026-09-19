# Historical public DCAP fixtures

`dcap-qvl-v0.6.1-tdx-quote.hex` and
`dcap-qvl-v0.6.1-tdx-collateral.json` come from Phala-Network/dcap-qvl v0.6.1,
commit `6ac45907f814e1c3e8bfc1b0e3c6a99710d4ef9f`, at `sample/tdx_quote` and
`sample/tdx_quote_collateral.json`. The upstream MIT license is retained in
`DCAP-QVL-LICENSE`.

- Quote bytes SHA-256: `c42f9164325024bca2757bc8819b11879a0a369132ea4e2b7c85df4805ea72db`.
- Collateral text SHA-256, excluding the added terminal newline:
  `b0a5f5fd620a8881b1eda45261fdf30dd930b49aff93231556645c81fcb4c0bc`.
- Verification uses the fixed historical timestamp `1750329147`.

These are genuine public hardware-verification fixtures, unrelated to user data
or our deployed service. Passing historical verification does not establish
current collateral freshness, current workload identity, or model provenance.
Other synthetic upstream/trade test vectors remain labeled synthetic in tests.
See the repository's `TESTING.md` for offline dependency installation and commands.
