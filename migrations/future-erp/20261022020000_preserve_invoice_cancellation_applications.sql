-- Cancellation is a terminal invoice action. Its credit application must remain
-- applied, even through another SDK entry point or direct SQL. A scoped foreign
-- key supplies PostgreSQL's concurrency/isolation checks; no mutable flag sync.
-- Existing ended cancellation applications cause migration failure and require
-- evidence-based reconciliation. Never silently reapply or rewrite them here.
create unique index subledger_applications_status_scope_uidx
  on erp_financials.subledger_applications
  (tenant_id, company_id, source_id, subledger_application_id, status);

alter table erp_financials.invoice_voids
  add column application_status text not null default 'applied',
  add constraint invoice_voids_application_status_check check (application_status = 'applied'),
  add constraint invoice_voids_active_application_fk
    foreign key (tenant_id, company_id, source_id, application_id, application_status)
    references erp_financials.subledger_applications
      (tenant_id, company_id, source_id, subledger_application_id, status)
    on update restrict on delete restrict;

create index invoice_voids_application_scope_idx
  on erp_financials.invoice_voids
  (tenant_id, company_id, source_id, application_id, application_status);
