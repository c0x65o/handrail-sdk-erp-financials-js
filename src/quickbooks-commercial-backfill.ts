import { createHash } from "node:crypto";
import type { NormalizedQuickBooksLedgerTransaction } from "./normalized-accounting-contracts.js";
import type { PostgresQueryClient } from "./postgres-storage.js";
import { planQuickBooksCommercialDetail, QuickBooksCommercialDetailError } from "./quickbooks-commercial-detail.js";

export type QuickBooksCommercialBackfillInput = {
  tenantId: string;
  companyId: string;
  sourceId: string;
  actorRef: string;
  recordedAt: string;
  /** Normalized provider documents with safe source references; never raw payloads. */
  documents: readonly NormalizedQuickBooksLedgerTransaction[];
};
export type CommercialBackfillStatement = { sql: string; params: (string | number | boolean | null)[] };
export type QuickBooksCommercialBackfillDocument = {
  sourceTransactionId: string;
  documentId?: string;
  status: "repairable" | "unchanged" | "blocked";
  reason?: string;
  fingerprint?: string;
  lineCount?: number;
  /** All statements for one document require one transaction. A stale preview fails before mutation. */
  statements: CommercialBackfillStatement[];
  before?: Record<string, unknown>;
};

/** Read-only, versioned repair planning. Does not post journals, replay payments, or mutate a database. */
export async function previewQuickBooksCommercialBackfill(
  client: PostgresQueryClient,
  input: QuickBooksCommercialBackfillInput
): Promise<QuickBooksCommercialBackfillDocument[]> {
  if (input.documents.length > 100) throw new Error("Commercial backfill previews are limited to 100 documents");
  if (!input.actorRef || !Number.isFinite(Date.parse(input.recordedAt))) throw new Error("Backfill requires actor and recorded time");
  const source = await client.query<{ source_system: string }>(
    `select source.source_system from erp_financials.accounting_sources source
     join erp_financials.company_sources binding on binding.tenant_id=source.tenant_id and binding.source_id=source.source_id
     where source.tenant_id=$1 and source.source_id=$2 and binding.company_id=$3`, [input.tenantId, input.sourceId, input.companyId]);
  if (source.rows.length !== 1 || source.rows[0]?.source_system !== "quickbooks") throw new Error("Backfill requires an exact QuickBooks company/source binding");
  const accounts = await client.query<{ sourceAccountId: string; accountId: string }>(
    `select source_account_id as "sourceAccountId", account_id as "accountId" from erp_financials.accounts where tenant_id=$1 and source_id=$2`, [input.tenantId, input.sourceId]);
  const items = await client.query<{ sourceItemId: string; itemId: string; incomeAccountId?: string; expenseAccountId?: string }>(
    `select source_item_id as "sourceItemId", item_id as "itemId", income_account_id as "incomeAccountId", expense_account_id as "expenseAccountId" from erp_financials.items where tenant_id=$1 and source_id=$2`, [input.tenantId, input.sourceId]);
  const parties = await client.query<{ source_party_id: string; party_id: string }>(
    `select source_party_id, party_id from erp_financials.parties where tenant_id=$1 and source_id=$2 and party_type='customer'`, [input.tenantId, input.sourceId]);
  const customerIds = new Map(parties.rows.map(row => [row.source_party_id, row.party_id]));
  const results: QuickBooksCommercialBackfillDocument[] = [];
  const seen = new Set<string>();
  for (const document of input.documents) {
    const key = `${document.sourceTransactionType}:${document.sourceTransactionId}`;
    if (seen.has(key)) throw new Error("Duplicate document in backfill preview");
    seen.add(key);
    const blocked = (reason: string) => results.push({ sourceTransactionId: document.sourceTransactionId, status: "blocked", reason, statements: [] });
    if (!["Invoice", "Bill", "CreditMemo", "VendorCredit"].includes(document.sourceTransactionType)) { blocked("unsupported_document_type"); continue; }
    const rows = await client.query<{
      subledger_document_id: string; version: number; original_amount: string; document_date: string;
      party_id: string | null; currency_code: string; document_number: string | null; status: string; metadata: Record<string, unknown>; line_hash: string;
      before_lines: unknown;
    }>(`select d.subledger_document_id,d.version,d.original_amount::text,d.document_date::text,d.currency_code,d.document_number,d.status,d.metadata,d.party_id,
      coalesce((select md5(jsonb_agg(to_jsonb(l) order by l.line_number)::text) from erp_financials.subledger_document_lines l where l.tenant_id=d.tenant_id and l.source_id=d.source_id and l.company_id=d.company_id and l.subledger_document_id=d.subledger_document_id),md5('[]'))::uuid::text as line_hash,
      coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object('quantity',l.quantity::text,'unit_amount',l.unit_amount::text,'line_amount',l.line_amount::text,'discount_amount',l.discount_amount::text,'tax_amount',l.tax_amount::text,'unit_cost',l.unit_cost::text) order by l.line_number) from erp_financials.subledger_document_lines l where l.tenant_id=d.tenant_id and l.source_id=d.source_id and l.company_id=d.company_id and l.subledger_document_id=d.subledger_document_id),'[]'::jsonb) as before_lines
      from erp_financials.subledger_documents d where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$3
      and d.metadata->>'provider'='quickbooks' and d.metadata->>'sourceTransactionType'=$4 and d.metadata->>'sourceTransactionId'=$5`,
      [input.tenantId, input.companyId, input.sourceId, document.sourceTransactionType, document.sourceTransactionId]);
    const existing = rows.rows[0];
    if (rows.rows.length !== 1 || !existing) { blocked("missing_or_ambiguous_existing_document"); continue; }
    if (existing.status === "voided") { blocked("voided_document"); continue; }
    if (canonicalDecimal(existing.original_amount) !== canonicalDecimal(document.totalAmount ?? "") || existing.document_date !== document.transactionDate
      || existing.currency_code !== document.currencyCode || (existing.document_number ?? undefined) !== (document.transactionNumber ?? undefined)
      || !document.sourceUpdatedAt || existing.metadata.sourceUpdatedAt !== document.sourceUpdatedAt) { blocked("source_revision_or_header_mismatch"); continue; }
    let plan;
    try { plan = planQuickBooksCommercialDetail(document, { accounts: accounts.rows, items: items.rows }); }
    catch (error) { if (!(error instanceof QuickBooksCommercialDetailError)) throw error; blocked(error.reason); continue; }
    const metadata = existing.metadata.commercialDetail as { fingerprint?: string; lineChecksum?: string } | undefined;
    if (metadata?.fingerprint === plan.fingerprint && metadata.lineChecksum === existing.line_hash) {
      results.push({ sourceTransactionId: document.sourceTransactionId, documentId: existing.subledger_document_id, status: "unchanged", fingerprint: plan.fingerprint, statements: [] }); continue;
    }
    if (plan.lines.some(line => line.source.partyRef?.partyType === "customer" && !customerIds.has(line.source.partyRef.sourceObjectId))) { blocked("unresolved_line_customer"); continue; }
    const documentId = existing.subledger_document_id;
    const scope = [input.tenantId, input.companyId, input.sourceId, documentId];
    const beforeLines = Array.isArray(existing.before_lines) ? existing.before_lines as Record<string, unknown>[] : [];
    const priorById = new Map(beforeLines.map(line => [String(line.subledger_document_line_id), line]));
    const lines = plan.lines.map(line => {
      const id = stableId("qbo_document_line", documentId, line.source.sourceLineId ?? String(line.source.lineNumber));
      const prior = priorById.get(id);
      return ({
      id,
      line_number: line.source.lineNumber, account_id: line.accountId, item_id: line.itemId ?? null,
      customer_party_id: line.source.partyRef?.partyType === "customer" ? customerIds.get(line.source.partyRef.sourceObjectId) ?? null : prior?.customer_party_id ?? (["Invoice", "CreditMemo"].includes(document.sourceTransactionType) ? existing.party_id : null),
      description: line.source.description ?? null, quantity: line.quantity, unit_amount: line.unitAmount,
      discount_amount: line.discountAmount, tax_amount: line.taxAmount, tax_code: line.source.taxCode ?? null,
      dimension_refs: line.source.dimensionRefs ?? prior?.dimension_refs ?? [], line_amount: line.amount,
      unit_cost: prior?.unit_cost ?? null,
      service_period_start: prior?.service_period_start ?? null,
      service_period_end: prior?.service_period_end ?? null
    }); });
    const decimalFields = new Set(["quantity", "unit_amount", "line_amount", "discount_amount", "tax_amount", "unit_cost"]);
    const sameDetail = lines.length === beforeLines.length && lines.every(line => {
      const previous = priorById.get(line.id);
      return previous && Object.entries(line).every(([field, value]) => {
        const before = previous[field === "id" ? "subledger_document_line_id" : field];
        return decimalFields.has(field) && value !== null && before !== null
          ? canonicalDecimal(String(value)) === canonicalDecimal(String(before))
          : JSON.stringify(value ?? null) === JSON.stringify(before ?? null);
      });
    });
    if (sameDetail) {
      results.push({ sourceTransactionId: document.sourceTransactionId, documentId, status: "unchanged", fingerprint: plan.fingerprint, statements: [] });
      continue;
    }
    const payload = JSON.stringify({ version: plan.version, fingerprint: plan.fingerprint, beforeLineChecksum: existing.line_hash,
      sourceTransactionId: document.sourceTransactionId, sourceTransactionType: document.sourceTransactionType,
      sourceUpdatedAt: document.sourceUpdatedAt, lineCount: lines.length, totalTax: plan.totalTax });
    const eventKey = `qbo-commercial-v2:${documentId}:${plan.fingerprint}:${existing.line_hash}`;
    const statements: CommercialBackfillStatement[] = [
      { sql: `select subledger_document_id from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4 for update`, params: scope },
      { sql: `select 1 / (case when exists(select 1 from erp_financials.subledger_documents d where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$3 and d.subledger_document_id=$4 and d.version=$5 and d.status<>'voided'
        and coalesce((select md5(jsonb_agg(to_jsonb(l) order by l.line_number)::text) from erp_financials.subledger_document_lines l where l.tenant_id=d.tenant_id and l.company_id=d.company_id and l.source_id=d.source_id and l.subledger_document_id=d.subledger_document_id),md5('[]'))::uuid::text=$6) then 1 else 0 end) as preview_still_current`, params: [...scope, existing.version, existing.line_hash] },
      { sql: `select set_config('erp_financials.quickbooks_projection_refresh','on',true)`, params: [] },
      { sql: `delete from erp_financials.subledger_document_lines where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4`, params: scope },
      { sql: `insert into erp_financials.subledger_document_lines (subledger_document_line_id,tenant_id,company_id,source_id,subledger_document_id,line_number,account_id,item_id,customer_party_id,description,quantity,unit_amount,discount_amount,tax_code,tax_amount,dimension_refs,line_amount,unit_cost,service_period_start,service_period_end)
        select line.id,$1,$2,$3,$4,line.line_number,line.account_id,line.item_id,line.customer_party_id,line.description,line.quantity,line.unit_amount,line.discount_amount,line.tax_code,line.tax_amount,line.dimension_refs,line.line_amount,line.unit_cost,line.service_period_start,line.service_period_end
        from jsonb_to_recordset($5::jsonb) as line(id text,line_number integer,account_id text,item_id text,customer_party_id text,description text,quantity numeric,unit_amount numeric,discount_amount numeric,tax_code text,tax_amount numeric,dimension_refs jsonb,line_amount numeric,unit_cost numeric,service_period_start date,service_period_end date)`, params: [...scope, JSON.stringify(lines)] },
      { sql: `update erp_financials.subledger_documents d set metadata=d.metadata || jsonb_build_object('commercialDetail',jsonb_build_object('version',2,'status','complete','fingerprint',$5::text,'totalTax',$6::text,'lineChecksum',(select md5(jsonb_agg(to_jsonb(l) order by l.line_number)::text)::uuid::text from erp_financials.subledger_document_lines l where l.tenant_id=d.tenant_id and l.company_id=d.company_id and l.source_id=d.source_id and l.subledger_document_id=d.subledger_document_id))),version=version+1,updated_at=$7::timestamptz
        where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$3 and d.subledger_document_id=$4`, params: [...scope, plan.fingerprint, plan.totalTax, input.recordedAt] },
      { sql: `insert into erp_financials.financial_lifecycle_events (event_id,tenant_id,company_id,source_id,aggregate_type,aggregate_id,event_type,actor_ref,request_id,correlation_id,reason_code,occurred_at,recorded_at,idempotency_key,payload_checksum,payload)
        values ($1,$2,$3,$4,'quickbooks_import',$5,'quickbooks_commercial_detail_backfilled',$6,$7,$7,'quickbooks_commercial_detail_v2',$8::timestamptz,$8::timestamptz,$7,$9,$10::jsonb)`, params: [stableId("qbo_detail_event", eventKey), input.tenantId, input.companyId, input.sourceId, documentId, input.actorRef, eventKey, input.recordedAt, hash(payload), payload] },
      { sql: `select 1 / (case when (select sum(line_amount) from erp_financials.subledger_document_lines where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4)=(select original_amount from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2 and source_id=$3 and subledger_document_id=$4) then 1 else 0 end) as repaired_total_matches`, params: scope },
      { sql: `select set_config('erp_financials.quickbooks_projection_refresh','off',true)`, params: [] }
    ];
    results.push({ sourceTransactionId: document.sourceTransactionId, documentId, status: "repairable", fingerprint: plan.fingerprint,
      lineCount: lines.length, statements, before: { ...existing } });
  }
  return results;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${hash(parts.join("\u0000")).slice(0, 24)}`; }

function canonicalDecimal(value: string): string { return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value; }
