-- Durable database-wide maintenance. Default open preserves ordinary consumers.
-- Shared advisory locks avoid a contended row MultiXact on normal RC writes.
CREATE TABLE erp_financials.accounting_access_control (
 control_id text PRIMARY KEY,
 revision integer NOT NULL DEFAULT 0,
 active_session_id text,
 CONSTRAINT accounting_access_control_singleton_check CHECK(control_id='database'),
 CONSTRAINT accounting_access_control_revision_check CHECK(revision>=0)
);
INSERT INTO erp_financials.accounting_access_control(control_id) VALUES('database');
CREATE TABLE erp_financials.accounting_access_commands (
 command_key text PRIMARY KEY,request_digest text NOT NULL,revision integer NOT NULL,active_session_id text,
 actor_ref text NOT NULL,operation jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT accounting_access_commands_revision_check CHECK(revision>0),
 CONSTRAINT accounting_access_commands_digest_check CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 CONSTRAINT accounting_access_commands_operation_bounded_json_check CHECK(octet_length(coalesce(operation::text,''))<=8192)
);
CREATE UNIQUE INDEX accounting_access_commands_revision_unique ON erp_financials.accounting_access_commands(revision);
CREATE FUNCTION erp_financials.require_accounting_access(write_access boolean DEFAULT false) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE active_id text; presented text:=coalesce(current_setting('erp_financials.maintenance_session',true),'');
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('erp-financials:accounting-access',0));
 IF write_access AND current_setting('transaction_isolation')<>'read committed' THEN
  -- A pre-pause writer snapshot must serialize or fail, never see stale open state.
  SELECT active_session_id INTO active_id FROM erp_financials.accounting_access_control WHERE control_id='database' FOR SHARE;
 ELSE
  -- Volatile function SPI queries obtain a fresh snapshot in READ COMMITTED.
  -- An existing RR read sees a consistent pre-pause store or a paused store.
  SELECT active_session_id INTO active_id FROM erp_financials.accounting_access_control WHERE control_id='database';
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_maintenance_control_missing' USING ERRCODE='55000'; END IF;
 IF (active_id IS NOT NULL AND presented IS DISTINCT FROM active_id) OR (presented<>'' AND active_id IS DISTINCT FROM presented) THEN
  RAISE EXCEPTION 'accounting_maintenance_access_denied' USING ERRCODE='55000';
 END IF;
END;
$$;
CREATE FUNCTION erp_financials.guard_accounting_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM erp_financials.require_accounting_access(true);RETURN NULL;END;
$$;
CREATE FUNCTION erp_financials.guard_accounting_access_control() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR coalesce(current_setting('erp_financials.maintenance_control_write',true),'')<>txid_current()::text
  OR NEW.control_id<>OLD.control_id OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'accounting_maintenance_control_command_required' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE FUNCTION erp_financials.guard_accounting_access_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF coalesce(current_setting('erp_financials.maintenance_control_write',true),'')<>txid_current()::text THEN
  RAISE EXCEPTION 'accounting_maintenance_control_command_required' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE FUNCTION erp_financials.preserve_accounting_access_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'accounting_maintenance_evidence_immutable' USING ERRCODE='55000';END;
$$;
CREATE TRIGGER accounting_access_control_command BEFORE INSERT OR UPDATE OR DELETE ON erp_financials.accounting_access_control FOR EACH ROW EXECUTE FUNCTION erp_financials.guard_accounting_access_control();
CREATE TRIGGER accounting_access_control_no_truncate BEFORE TRUNCATE ON erp_financials.accounting_access_control FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.preserve_accounting_access_evidence();
CREATE TRIGGER accounting_access_command_insert BEFORE INSERT ON erp_financials.accounting_access_commands FOR EACH ROW EXECUTE FUNCTION erp_financials.guard_accounting_access_command();
CREATE TRIGGER accounting_access_commands_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON erp_financials.accounting_access_commands FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.preserve_accounting_access_evidence();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."schema_migrations" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."accounting_companies" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."accounting_sources" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."company_sources" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."financial_lifecycle_events" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."accounting_book_controls" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."fiscal_periods" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."accounts" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."parties" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."items" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."accounting_dimensions" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."transactions" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."transaction_lines" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."ledger_postings" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."journal_entry_links" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."subledger_documents" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."subledger_applications" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."bill_payment_disbursements" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."posting_rules" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."transaction_match_candidates" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."transaction_match_decisions" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."payment_applications" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."rollup_buckets" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."import_batches" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."sync_checkpoints" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."report_freshness" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."report_snapshots" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."report_snapshot_lines" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."report_snapshot_totals" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."reporting_books" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."reporting_book_sources" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."reporting_book_accounts" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."reporting_book_account_mappings" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."financial_outbox" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."invoice_drafts" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."invoice_draft_lines" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."subledger_document_lines" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."subledger_document_delivery_events" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."invoice_voids" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."bank_statement_lines" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."bank_reconciliation_matches" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."bank_statements" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."bank_statement_clearings" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."bank_statement_clearing_history" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."fiscal_close_certificates" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."fiscal_close_totals" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."fiscal_close_banks" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."cash_flow_purpose_corrections" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."accounting_source_revisions" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."imported_customer_payment_evidence" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
CREATE TRIGGER accounting_access_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON erp_financials."customer_payment_corrections" FOR EACH STATEMENT EXECUTE FUNCTION erp_financials.guard_accounting_access();
