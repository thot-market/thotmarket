# Research packages

Research is a separate content kind. It contains no fabricated conversation turns. Existing trace import, capture, QC and releases keep their prior format.

## Profile and user flow

Choose Research package when uploading work. Explicitly select report, code and data files, supply a title and name the Markdown/text main report. Review the complete inventory and inert file previews, then save privately. Confirm rights for every included file before preparing a sale. Review the actual release and licence, optionally exclude non-entrypoint files, then sign the ordinary listing authorization. A buyer receives the immutable package inside the existing licensed release, with its original file texts, byte sizes and SHA-256 hashes.

The versioned JSON profile is `thot.research-package/1`, kind `research`. Required fields are `schema_version`, `kind`, `title`, `entrypoint`, `files`, `relationships` and `provenance`. Each file has `path`, `media_type`, `role`, `sha256`, `bytes` and `text`. Provenance is exactly `{ "mode": "imported_declaration" }`. Ownership always comes from authenticated requests, never the manifest. File roles are report/code/data/evidence. Relationships reference included exact paths using generated_by/supports/references; import does not fetch outside references.

Supported media are Markdown (.md), plain text (.txt), JSON (.json), CSV (.csv), Python (.py) and JavaScript (.js/.mjs). All files are valid UTF-8 without NUL and are rendered as escaped text. Code and JSON/CSV contents are not executed; Markdown is not active HTML. Binary formats, archives, symlinks, external downloads and arbitrary renderers are unsupported. Limits are 32 files, 200,000 bytes per file, 1,000,000 total file bytes, 1,800,000 serialized JSON bytes and 128 relationships. Paths are relative ASCII paths without dot segments, backslashes or case-colliding names. The entrypoint is an included Markdown/text report. Unsupported profiles and media fail explicitly.

API users send `{kind:"research", filename:"package.json", text:JSON.stringify(package)}` to the existing contributor import preview endpoint, then confirm with the returned content commitment and `save_privately:true`. Direct research imports cannot simultaneously grant sale rights. The library endpoint returns exact package content only to its owner. Its download is a JSON package preserving UTF-8 file bytes; checksums let recipients reconstruct and verify each file without executing it.

## Trust, QC and licensing

Import provenance records custody at import time, not authenticated authorship, provider capture, source time or correctness. File-scoped QC reports inventory checks and sensitive-pattern coverage for each file. Code execution and research correctness remain unassessed. No check proves completeness, rights or value. Known credential/confidentiality findings block release; files are not silently rewritten to make a release pass. Remove sensitive files or author a new redacted package and review it. The package-level licence requires rights for every component, including third-party data/evidence and code.

A release exclusion removes selected non-entrypoint files and relationships touching them; hashes and bytes of surviving files remain unchanged. It advances the release commitment and QC version and leaves the private original intact. Once any listing or sale commitment exists, the release cannot be edited. New source versions are separate private imports with separate review/authorization; purchased releases retain their original bytes and entitlements. Public listings expose only explicitly authorized title/terms and coarse kind/file-count metadata, not private filenames or content.

## Compatibility and recovery

Discovery found encrypted object references and the existing release evidence hash already bind JSON content without requiring conversation turns. The database's historical traces table remains an internal storage name; `content_kind:research` routes parsing, rendering and QC. No SQL migration or contract change is required. Research is THOT-listing-only and cannot enter legacy standing trace mandates. Existing source retention, encrypted quotas, staged writes, ownership and signed release/delivery protections apply. Failed imports do not publish a partial package; staged cleanup handles temporary objects and retry recovers metadata without duplicate inventory.

Roll back only to an image that understands retained research content, or disable research writes and retain this reader/API until a compatible recovery image is available. Deployments preserve encrypted objects, object keys, database/chain state, volumes and previous licensed artifacts. There is no destructive down migration. Hosted acceptance must verify existing trace readback and package delivery, not just container health.
