-- Explicit component accounts were previously supported only on positive invoices.
-- Preserve legacy/imported arithmetic when no tax posting account was selected.
-- No accounting rows are rewritten; this only admits the reviewed vendor-credit contract.
ALTER TABLE erp_financials.subledger_document_lines
  DROP CONSTRAINT subledger_document_lines_arithmetic_check,
  ADD CONSTRAINT subledger_document_lines_arithmetic_check CHECK (
    discount_amount <= abs(round(quantity * unit_amount, 2))
    AND line_amount = round(quantity * unit_amount, 2)
      - CASE WHEN quantity * unit_amount < 0 THEN -discount_amount ELSE discount_amount END
      + CASE WHEN quantity * unit_amount < 0 AND tax_account_id IS NOT NULL THEN -tax_amount ELSE tax_amount END
  );
