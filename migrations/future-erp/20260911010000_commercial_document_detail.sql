-- Commercial discounts and returns retain their provider sign. Native draft validation remains unchanged.
ALTER TABLE erp_financials.subledger_document_lines
  DROP CONSTRAINT subledger_document_lines_amount_check,
  DROP CONSTRAINT subledger_document_lines_scale_check,
  DROP CONSTRAINT subledger_document_lines_arithmetic_check,
  ADD CONSTRAINT subledger_document_lines_amount_check CHECK (discount_amount >= 0 and (quantity <> 0 or (line_amount = 0 and discount_amount = 0 and tax_amount = 0))),
  ADD CONSTRAINT subledger_document_lines_scale_check CHECK (scale(quantity) <= 12 and scale(unit_amount) <= 12 and scale(discount_amount) <= 2 and scale(tax_amount) <= 2 and scale(line_amount) <= 2),
  ADD CONSTRAINT subledger_document_lines_arithmetic_check CHECK (discount_amount <= abs(round(quantity * unit_amount, 2)) and line_amount = round(quantity * unit_amount, 2) - (case when quantity * unit_amount < 0 then -discount_amount else discount_amount end) + tax_amount);
