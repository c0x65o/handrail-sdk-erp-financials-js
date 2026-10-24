-- Explicit native invoice components. Historical lines retain their original
-- posting treatment; no amounts or accounting history are rewritten.
ALTER TABLE erp_financials.invoice_draft_lines ADD COLUMN tax_account_id text, ADD COLUMN discount_account_id text;
ALTER TABLE erp_financials.subledger_document_lines ADD COLUMN tax_account_id text, ADD COLUMN discount_account_id text;
ALTER TABLE erp_financials.invoice_draft_lines
 ADD CONSTRAINT invoice_draft_lines_tax_account_scope_fk FOREIGN KEY(tenant_id,source_id,tax_account_id) REFERENCES erp_financials.accounts(tenant_id,source_id,account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 ADD CONSTRAINT invoice_draft_lines_discount_account_scope_fk FOREIGN KEY(tenant_id,source_id,discount_account_id) REFERENCES erp_financials.accounts(tenant_id,source_id,account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 ADD CONSTRAINT invoice_draft_lines_component_amount_check CHECK((tax_account_id IS NULL OR tax_amount>0) AND (discount_account_id IS NULL OR discount_amount>0));
ALTER TABLE erp_financials.subledger_document_lines
 ADD CONSTRAINT subledger_document_lines_tax_account_scope_fk FOREIGN KEY(tenant_id,source_id,tax_account_id) REFERENCES erp_financials.accounts(tenant_id,source_id,account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 ADD CONSTRAINT subledger_document_lines_discount_account_scope_fk FOREIGN KEY(tenant_id,source_id,discount_account_id) REFERENCES erp_financials.accounts(tenant_id,source_id,account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 ADD CONSTRAINT subledger_document_lines_component_amount_check CHECK((tax_account_id IS NULL OR tax_amount>0) AND (discount_account_id IS NULL OR discount_amount>0));
