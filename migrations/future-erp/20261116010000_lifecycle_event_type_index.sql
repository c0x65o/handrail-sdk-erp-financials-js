-- Guard predicates must not scan every imported lifecycle event per application.
-- Preserve all retirement/correction validation; only add its access path.
create index financial_lifecycle_events_type_scope_idx
on erp_financials.financial_lifecycle_events (tenant_id, company_id, source_id, event_type);
