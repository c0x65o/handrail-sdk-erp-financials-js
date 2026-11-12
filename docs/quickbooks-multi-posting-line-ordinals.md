# QuickBooks multi-posting canonical line ordinals (0.3.214)

A normalized QuickBooks source line can contain several accounting postings. The service SDK envelope adapter groups those postings under the original provider line ID. The financial adapter previously expanded them into separate canonical transaction lines but reused the provider line number, violating the canonical database uniqueness constraint on transaction and line number.

The adapter now assigns consecutive canonical ordinals to transactions containing expanded lines. Original provider line IDs, posting IDs, payload references, amounts and canonical posting-derived identities remain unchanged. Transactions with one posting per source line keep their previous ordinals. Operational documents are unaffected.

Spartan and other consumers of `@handrail/erp-financials` should adopt this upstream fix before importing normalized transactions that contain multiple postings per provider line. No provider write, data deletion or accounting adjustment is required by this change. Existing failed imports should be inspected before an authorized idempotent retry.

Regression coverage: `test/source-adapters.test.ts` groups the same balanced invoice postings under one provider line, checks unique canonical ordinals and unchanged stable identities/provenance, and verifies deterministic replay. The failure reproduced as `[1, 1]` instead of `[1, 2]` before the fix.
