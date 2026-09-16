import { createHash } from "node:crypto";

import { ErpFinancialsError } from "./sdk-errors.js";
import { assertFinancialOperationContext } from "./financial-lifecycle.js";

import type { AccountClassification, AccountingBasis, IsoCurrencyCode, IsoDate, IsoDateTime, SourceId } from "./canonical-model.js";
import type { ErpFinancialsTransactionRunner } from "./erp-financials-service.js";
import type { FinancialOperationContext } from "./financial-lifecycle.js";

export type ReportingBookStatus = "active" | "archived";
export type ReportingBookSourceRole = "historical" | "active" | "adjustment";
export type ReportingBookAccountRole = "header" | "posting";

export type ReportingBook = {
  readonly bookId: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly name: string;
  readonly baseCurrencyCode: IsoCurrencyCode;
  readonly accountingBasis: AccountingBasis;
  readonly status: ReportingBookStatus;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
};

export type ReportingBookSource = {
  readonly bookSourceId: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly bookId: string;
  readonly sourceId: SourceId;
  readonly sourceRole: ReportingBookSourceRole;
  readonly effectiveFrom?: IsoDate;
  readonly effectiveThrough?: IsoDate;
  readonly createdAt: IsoDateTime;
};

export type ReportingBookAccountMapping = {
  readonly bookAccountMappingId: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly bookId: string;
  readonly sourceId: SourceId;
  readonly accountId: string;
  readonly bookAccountKey: string;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
};

export type ReportingBookAccount = {
  readonly bookAccountId: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly bookId: string;
  readonly bookAccountKey: string;
  readonly accountNumber?: string;
  readonly name: string;
  readonly classification: AccountClassification;
  readonly accountType?: string;
  readonly accountSubtype?: string;
  readonly accountRole: ReportingBookAccountRole;
  readonly parentBookAccountKey?: string;
  readonly currencyCode?: IsoCurrencyCode;
  readonly active: boolean;
  readonly version: number;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
};

export type DefineReportingBookAccountInput = {
  readonly operation: FinancialOperationContext;
  readonly bookId: string;
  readonly bookAccountKey: string;
  readonly accountNumber?: string;
  readonly name: string;
  readonly classification: AccountClassification;
  readonly accountType?: string;
  readonly accountSubtype?: string;
  readonly accountRole: ReportingBookAccountRole;
  readonly parentBookAccountKey?: string;
  readonly currencyCode?: IsoCurrencyCode;
  /** False retains identity and mappings for history but disallows new native postings. Defaults to true. */
  readonly active?: boolean;
  /** Use 0 to create; pass the returned version for every subsequent mutation. */
  readonly expectedVersion: number;
};

export type DefineReportingBookInput = {
  readonly operation: FinancialOperationContext;
  readonly bookId: string;
  readonly name: string;
  readonly baseCurrencyCode: IsoCurrencyCode;
  readonly accountingBasis?: AccountingBasis;
  readonly status?: ReportingBookStatus;
};

export type BindReportingBookSourceInput = {
  readonly operation: FinancialOperationContext;
  readonly bookId: string;
  readonly sourceId: SourceId;
  readonly sourceRole: ReportingBookSourceRole;
  readonly effectiveFrom?: IsoDate;
  readonly effectiveThrough?: IsoDate;
};

export type MapReportingBookAccountInput = {
  readonly operation: FinancialOperationContext;
  readonly bookId: string;
  readonly sourceId: SourceId;
  readonly accountId: string;
  readonly bookAccountKey: string;
};

export type ReportingBookResolvedScope = {
  readonly book: ReportingBook;
  readonly sources: readonly ReportingBookSource[];
};

export type ReportingBookService = {
  define(input: DefineReportingBookInput): Promise<ReportingBook>;
  bindSource(input: BindReportingBookSourceInput): Promise<ReportingBookSource>;
  defineAccount(input: DefineReportingBookAccountInput): Promise<ReportingBookAccount>;
  /** Retains a reporting identity even for inactive posting accounts; does not grant posting eligibility. */
  mapAccount(input: MapReportingBookAccountInput): Promise<ReportingBookAccountMapping>;
  resolve(bookId: string, asOfDate?: IsoDate): Promise<ReportingBookResolvedScope>;
};

export function createReportingBookService(input: {
  readonly database: ErpFinancialsTransactionRunner;
  readonly tenantId: string;
  readonly companyId: string;
  readonly now?: () => IsoDateTime;
}): ReportingBookService {
  const now = input.now ?? (() => new Date().toISOString());
  assertNonEmpty(input.tenantId, "tenantId");
  assertNonEmpty(input.companyId, "companyId");

  return {
    define: (command) => defineBook(input.database, input.tenantId, input.companyId, now, command),
    bindSource: (command) => bindSource(input.database, input.tenantId, input.companyId, now, command),
    defineAccount: (command) => defineBookAccount(input.database, input.tenantId, input.companyId, now, command),
    mapAccount: (command) => mapAccount(input.database, input.tenantId, input.companyId, now, command),
    resolve: (bookId, asOfDate) => resolveBook(input.database, input.tenantId, input.companyId, bookId, asOfDate)
  };
}

async function defineBookAccount(
  database: ErpFinancialsTransactionRunner,
  tenantId: string,
  companyId: string,
  now: () => IsoDateTime,
  input: DefineReportingBookAccountInput
): Promise<ReportingBookAccount> {
  assertOperation(input.operation);
  assertNonEmpty(input.bookId, "bookId");
  assertNonEmpty(input.bookAccountKey, "bookAccountKey");
  assertNonEmpty(input.name, "name");
  assertClassification(input.classification);
  assertAccountRole(input.accountRole);
  assertExpectedVersion(input.expectedVersion);
  if (input.accountNumber !== undefined) {
    assertNonEmpty(input.accountNumber, "accountNumber");
    if (input.accountNumber !== input.accountNumber.trim()) {
      throw new ErpFinancialsError("invalid_input", "accountNumber must not have leading or trailing whitespace");
    }
  }
  if (input.parentBookAccountKey === input.bookAccountKey) {
    throw new ErpFinancialsError("invalid_account_hierarchy", "A reporting-book account cannot be its own parent");
  }
  const bookAccountId = stableId("book_account", tenantId, companyId, input.bookId, input.bookAccountKey);
  const timestamp = now();
  try {
    return await database.transaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `reporting-book-accounts:${tenantId}:${companyId}:${input.bookId}`
    ]);
    const bookAndParent = await client.query(
      `select book."base_currency_code", parent."classification" as "parent_classification",
  parent."account_role" as "parent_account_role", parent."active" as "parent_active"
from "erp_financials"."reporting_books" book
left join "erp_financials"."reporting_book_accounts" parent
  on parent."tenant_id" = book."tenant_id" and parent."company_id" = book."company_id" and parent."book_id" = book."book_id"
 and parent."book_account_key" = $4
where book."tenant_id" = $1 and book."company_id" = $2 and book."book_id" = $3`,
      [tenantId, companyId, input.bookId, input.parentBookAccountKey]
    );
    const bookRow = bookAndParent.rows[0];
    if (bookRow === undefined) throw new ErpFinancialsError("missing_book", `Reporting book ${input.bookId} does not exist`);
    const parentClassification = optionalStringField(bookRow, "parent_classification");
    if (input.currencyCode !== undefined && input.currencyCode !== bookRow.base_currency_code) {
      throw new ErpFinancialsError("currency_not_supported", "Book-account currency must match the reporting book base currency");
    }
    if (input.parentBookAccountKey !== undefined && parentClassification === undefined) {
      throw new ErpFinancialsError("invalid_account_hierarchy", `Parent book account ${input.parentBookAccountKey} does not exist`);
    }
    if (parentClassification !== undefined && parentClassification !== input.classification) {
      throw new ErpFinancialsError("invalid_account_hierarchy", "A book account and its parent must share a classification");
    }
    if (input.parentBookAccountKey !== undefined &&
      (bookRow.parent_account_role !== "header" || bookRow.parent_active !== true)) {
      throw new ErpFinancialsError("invalid_account_hierarchy", "A reporting-book parent must be an active header account");
    }
    const mutationChecksum = accountMutationChecksum(input);
    const currentResult = await client.query(
      `select * from "erp_financials"."reporting_book_accounts"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "book_account_key" = $4
for update`,
      [tenantId, companyId, input.bookId, input.bookAccountKey]
    );
    const currentAccount = currentResult.rows[0];
    if (currentAccount !== undefined && currentAccount.last_operation_request_id === input.operation.requestId) {
      if (currentAccount.last_operation_checksum !== mutationChecksum) {
        throw new ErpFinancialsError("idempotency_conflict", "The reporting-book account request id was reused with different input", {
          details: { bookAccountKey: input.bookAccountKey, bookId: input.bookId, requestId: input.operation.requestId }
        });
      }
      return reportingBookAccountFromRow(currentAccount);
    }
    const actualVersion = currentAccount === undefined ? 0 : integerField(currentAccount, "version");
    if (actualVersion !== input.expectedVersion) {
      throw new ErpFinancialsError("optimistic_concurrency_conflict", `Reporting-book account ${input.bookAccountKey} changed concurrently`, {
        retryable: true,
        details: { bookAccountKey: input.bookAccountKey, bookId: input.bookId, expectedVersion: input.expectedVersion, actualVersion }
      });
    }
    const result = await client.query(
      `insert into "erp_financials"."reporting_book_accounts" (
  "book_account_id", "tenant_id", "company_id", "book_id", "book_account_key", "account_number", "name",
  "classification", "account_type", "account_subtype", "account_role", "parent_book_account_key", "currency_code", "active",
  "version", "last_operation_request_id", "last_operation_checksum", "created_at", "updated_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $16, $17, $15, $15)
on conflict ("tenant_id", "company_id", "book_id", "book_account_key") do update
set "account_number" = excluded."account_number", "name" = excluded."name", "account_type" = excluded."account_type",
    "account_subtype" = excluded."account_subtype", "account_role" = excluded."account_role",
    "parent_book_account_key" = excluded."parent_book_account_key", "active" = excluded."active",
    "version" = case
      when "erp_financials"."reporting_book_accounts"."last_operation_request_id" = excluded."last_operation_request_id"
       and "erp_financials"."reporting_book_accounts"."last_operation_checksum" = excluded."last_operation_checksum"
      then "erp_financials"."reporting_book_accounts"."version"
      else "erp_financials"."reporting_book_accounts"."version" + 1 end,
    "last_operation_request_id" = excluded."last_operation_request_id",
    "last_operation_checksum" = excluded."last_operation_checksum",
    "updated_at" = case
      when "erp_financials"."reporting_book_accounts"."last_operation_request_id" = excluded."last_operation_request_id"
       and "erp_financials"."reporting_book_accounts"."last_operation_checksum" = excluded."last_operation_checksum"
      then "erp_financials"."reporting_book_accounts"."updated_at" else excluded."updated_at" end
where "erp_financials"."reporting_book_accounts"."classification" = excluded."classification"
  and "erp_financials"."reporting_book_accounts"."currency_code" is not distinct from excluded."currency_code"
  and (("erp_financials"."reporting_book_accounts"."last_operation_request_id" = excluded."last_operation_request_id"
    and "erp_financials"."reporting_book_accounts"."last_operation_checksum" = excluded."last_operation_checksum")
    or ("erp_financials"."reporting_book_accounts"."last_operation_request_id" <> excluded."last_operation_request_id"
      and "erp_financials"."reporting_book_accounts"."version" = $18))
returning *`,
      [bookAccountId, tenantId, companyId, input.bookId, input.bookAccountKey, input.accountNumber, input.name,
        input.classification, input.accountType, input.accountSubtype, input.accountRole, input.parentBookAccountKey,
        input.currencyCode, input.active ?? true, timestamp, input.operation.requestId, mutationChecksum,
        input.expectedVersion]
    );
    const row = result.rows[0];
    if (row === undefined) {
      const concurrentResult = await client.query(
        `select "version", "last_operation_request_id", "last_operation_checksum"
from "erp_financials"."reporting_book_accounts"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "book_account_key" = $4`,
        [tenantId, companyId, input.bookId, input.bookAccountKey]
      );
      const current = concurrentResult.rows[0];
      if (current !== undefined && current.last_operation_request_id === input.operation.requestId &&
        current.last_operation_checksum !== mutationChecksum) {
        throw new ErpFinancialsError("idempotency_conflict", "The reporting-book account request id was reused with different input", {
          details: { bookAccountKey: input.bookAccountKey, bookId: input.bookId, requestId: input.operation.requestId }
        });
      }
      throw new ErpFinancialsError("optimistic_concurrency_conflict", `Reporting-book account ${input.bookAccountKey} changed concurrently`, {
        retryable: true,
        details: {
          bookAccountKey: input.bookAccountKey,
          bookId: input.bookId,
          expectedVersion: input.expectedVersion,
          ...(current === undefined ? {} : { actualVersion: integerField(current, "version") })
        }
      });
    }
    await assertBookAccountAcyclic(client, tenantId, companyId, input.bookId, input.bookAccountKey);
    return reportingBookAccountFromRow(row);
    });
  } catch (cause) {
    if (isAccountNumberUniqueViolation(cause)) {
      throw new ErpFinancialsError("invalid_input", `Account number ${input.accountNumber ?? ""} is already used in reporting book ${input.bookId}`, {
        details: { accountNumber: input.accountNumber ?? "", bookId: input.bookId }, cause
      });
    }
    throw cause;
  }
}

async function defineBook(
  database: ErpFinancialsTransactionRunner,
  tenantId: string,
  companyId: string,
  now: () => IsoDateTime,
  input: DefineReportingBookInput
): Promise<ReportingBook> {
  assertOperation(input.operation);
  assertNonEmpty(input.bookId, "bookId");
  assertNonEmpty(input.name, "name");
  assertCurrency(input.baseCurrencyCode, "baseCurrencyCode");
  const accountingBasis = input.accountingBasis ?? "accrual";
  assertBasis(accountingBasis);
  const status = input.status ?? "active";
  const timestamp = now();

  return database.transaction(async (client) => {
    const result = await client.query(
      `insert into "erp_financials"."reporting_books" (
  "book_id", "tenant_id", "company_id", "name", "base_currency_code", "accounting_basis", "status", "created_at", "updated_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
on conflict ("tenant_id", "company_id", "book_id") do update
set "name" = excluded."name", "status" = excluded."status", "updated_at" = excluded."updated_at"
where "erp_financials"."reporting_books"."base_currency_code" = excluded."base_currency_code"
  and "erp_financials"."reporting_books"."accounting_basis" = excluded."accounting_basis"
returning *`,
      [input.bookId, tenantId, companyId, input.name, input.baseCurrencyCode, accountingBasis, status, timestamp]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ErpFinancialsError(
        "idempotency_conflict",
        `Reporting book ${input.bookId} cannot change base currency or accounting basis`,
        { details: { bookId: input.bookId } }
      );
    }
    return reportingBookFromRow(row);
  });
}

async function bindSource(
  database: ErpFinancialsTransactionRunner,
  tenantId: string,
  companyId: string,
  now: () => IsoDateTime,
  input: BindReportingBookSourceInput
): Promise<ReportingBookSource> {
  assertOperation(input.operation);
  assertNonEmpty(input.bookId, "bookId");
  assertNonEmpty(input.sourceId, "sourceId");
  if (!new Set(["historical", "active", "adjustment"]).has(input.sourceRole)) {
    throw new ErpFinancialsError("invalid_input", `Unsupported reporting book source role ${input.sourceRole}`);
  }
  assertWindow(input.effectiveFrom, input.effectiveThrough);
  const bookSourceId = stableId("book_source", tenantId, companyId, input.bookId, input.sourceId);
  return database.transaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `reporting-book-sources:${tenantId}:${companyId}:${input.bookId}`
    ]);
    const result = await client.query(
      `insert into "erp_financials"."reporting_book_sources" (
  "book_source_id", "tenant_id", "company_id", "book_id", "source_id", "source_role", "effective_from", "effective_through", "created_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
on conflict ("tenant_id", "company_id", "book_id", "source_id") do update
set "source_role" = excluded."source_role", "effective_from" = excluded."effective_from", "effective_through" = excluded."effective_through"
returning *`,
      [
        bookSourceId,
        tenantId,
        companyId,
        input.bookId,
        input.sourceId,
        input.sourceRole,
        input.effectiveFrom,
        input.effectiveThrough,
        now()
      ]
    );
    return reportingBookSourceFromRow(requiredRow(result.rows[0], "reporting book source"));
  });
}

async function mapAccount(
  database: ErpFinancialsTransactionRunner,
  tenantId: string,
  companyId: string,
  now: () => IsoDateTime,
  input: MapReportingBookAccountInput
): Promise<ReportingBookAccountMapping> {
  assertOperation(input.operation);
  assertNonEmpty(input.bookId, "bookId");
  assertNonEmpty(input.sourceId, "sourceId");
  assertNonEmpty(input.accountId, "accountId");
  assertNonEmpty(input.bookAccountKey, "bookAccountKey");
  const mappingId = stableId("book_account_mapping", tenantId, companyId, input.bookId, input.sourceId, input.accountId);
  const timestamp = now();
  return database.transaction(async (client) => {
    const compatibility = await client.query(
      `select source_account."classification" as "source_classification", book_account."classification" as "book_classification",
  book_account."account_role" as "book_account_role"
from "erp_financials"."reporting_book_sources" source
join "erp_financials"."accounts" source_account
  on source_account."tenant_id" = source."tenant_id" and source_account."source_id" = source."source_id" and source_account."account_id" = $5
join "erp_financials"."reporting_book_accounts" book_account
  on book_account."tenant_id" = source."tenant_id" and book_account."company_id" = source."company_id"
 and book_account."book_id" = source."book_id" and book_account."book_account_key" = $6
where source."tenant_id" = $1 and source."company_id" = $2 and source."book_id" = $3 and source."source_id" = $4`,
      [tenantId, companyId, input.bookId, input.sourceId, input.accountId, input.bookAccountKey]
    );
    const compatibilityRow = compatibility.rows[0];
    if (compatibilityRow === undefined) {
      throw new ErpFinancialsError("scope_mismatch", "Book account, source account, and source binding must all exist in the requested book");
    }
    if (compatibilityRow.source_classification !== compatibilityRow.book_classification) {
      throw new ErpFinancialsError("invalid_account_hierarchy", "A source account can only map to a book account with the same classification");
    }
    if (compatibilityRow.book_account_role !== "posting") {
      throw new ErpFinancialsError("invalid_account_hierarchy", "A source account can only map to a posting account");
    }
    const result = await client.query(
      `insert into "erp_financials"."reporting_book_account_mappings" (
  "book_account_mapping_id", "tenant_id", "company_id", "book_id", "source_id", "account_id", "book_account_key", "created_at", "updated_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
on conflict ("tenant_id", "company_id", "book_id", "source_id", "account_id") do update
set "book_account_key" = excluded."book_account_key", "updated_at" = excluded."updated_at"
returning *`,
      [mappingId, tenantId, companyId, input.bookId, input.sourceId, input.accountId, input.bookAccountKey, timestamp]
    );
    return reportingBookAccountMappingFromRow(requiredRow(result.rows[0], "reporting book account mapping"));
  });
}

async function resolveBook(
  database: ErpFinancialsTransactionRunner,
  tenantId: string,
  companyId: string,
  bookId: string,
  asOfDate?: IsoDate
): Promise<ReportingBookResolvedScope> {
  assertNonEmpty(bookId, "bookId");
  if (asOfDate !== undefined) {
    assertDate(asOfDate, "asOfDate");
  }
  return database.transaction(async (client) => {
    const bookResult = await client.query(
      `select * from "erp_financials"."reporting_books"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3`,
      [tenantId, companyId, bookId]
    );
    const bookRow = bookResult.rows[0];
    if (bookRow === undefined) {
      throw new ErpFinancialsError("missing_book", `Reporting book ${bookId} does not exist`, {
        details: { bookId }
      });
    }
    const sourceResult = await client.query(
      `select * from "erp_financials"."reporting_book_sources"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3
  and ($4::date is null or "effective_from" is null or "effective_from" <= $4::date)
  and ($4::date is null or "effective_through" is null or "effective_through" >= $4::date)
order by case "source_role" when 'historical' then 1 when 'active' then 2 else 3 end, "source_id"`,
      [tenantId, companyId, bookId, asOfDate]
    );
    return {
      book: reportingBookFromRow(bookRow),
      sources: sourceResult.rows.map(reportingBookSourceFromRow)
    };
  });
}

function reportingBookFromRow(row: Readonly<Record<string, unknown>>): ReportingBook {
  return {
    bookId: stringField(row, "book_id"),
    tenantId: stringField(row, "tenant_id"),
    companyId: stringField(row, "company_id"),
    name: stringField(row, "name"),
    baseCurrencyCode: stringField(row, "base_currency_code"),
    accountingBasis: stringField(row, "accounting_basis") as AccountingBasis,
    status: stringField(row, "status") as ReportingBookStatus,
    createdAt: dateTimeField(row, "created_at"),
    updatedAt: dateTimeField(row, "updated_at")
  };
}

function reportingBookSourceFromRow(row: Readonly<Record<string, unknown>>): ReportingBookSource {
  const effectiveFrom = optionalDateField(row, "effective_from");
  const effectiveThrough = optionalDateField(row, "effective_through");
  return {
    bookSourceId: stringField(row, "book_source_id"),
    tenantId: stringField(row, "tenant_id"),
    companyId: stringField(row, "company_id"),
    bookId: stringField(row, "book_id"),
    sourceId: stringField(row, "source_id"),
    sourceRole: stringField(row, "source_role") as ReportingBookSourceRole,
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveThrough === undefined ? {} : { effectiveThrough }),
    createdAt: dateTimeField(row, "created_at")
  };
}

function reportingBookAccountMappingFromRow(
  row: Readonly<Record<string, unknown>>
): ReportingBookAccountMapping {
  return {
    bookAccountMappingId: stringField(row, "book_account_mapping_id"),
    tenantId: stringField(row, "tenant_id"),
    companyId: stringField(row, "company_id"),
    bookId: stringField(row, "book_id"),
    sourceId: stringField(row, "source_id"),
    accountId: stringField(row, "account_id"),
    bookAccountKey: stringField(row, "book_account_key"),
    createdAt: dateTimeField(row, "created_at"),
    updatedAt: dateTimeField(row, "updated_at")
  };
}

function reportingBookAccountFromRow(row: Readonly<Record<string, unknown>>): ReportingBookAccount {
  const accountNumber = optionalStringField(row, "account_number");
  const accountType = optionalStringField(row, "account_type");
  const accountSubtype = optionalStringField(row, "account_subtype");
  const parentBookAccountKey = optionalStringField(row, "parent_book_account_key");
  const currencyCode = optionalStringField(row, "currency_code");
  return {
    bookAccountId: stringField(row, "book_account_id"),
    tenantId: stringField(row, "tenant_id"),
    companyId: stringField(row, "company_id"),
    bookId: stringField(row, "book_id"),
    bookAccountKey: stringField(row, "book_account_key"),
    ...(accountNumber === undefined ? {} : { accountNumber }),
    name: stringField(row, "name"),
    classification: stringField(row, "classification") as AccountClassification,
    ...(accountType === undefined ? {} : { accountType }),
    ...(accountSubtype === undefined ? {} : { accountSubtype }),
    accountRole: reportingBookAccountRoleField(row, "account_role"),
    ...(parentBookAccountKey === undefined ? {} : { parentBookAccountKey }),
    ...(currencyCode === undefined ? {} : { currencyCode }),
    active: row.active === true,
    version: integerField(row, "version"),
    createdAt: dateTimeField(row, "created_at"),
    updatedAt: dateTimeField(row, "updated_at")
  };
}

function accountMutationChecksum(input: DefineReportingBookAccountInput): string {
  return createHash("sha256").update(JSON.stringify({
    bookId: input.bookId,
    bookAccountKey: input.bookAccountKey,
    accountNumber: input.accountNumber ?? null,
    name: input.name,
    classification: input.classification,
    accountType: input.accountType ?? null,
    accountSubtype: input.accountSubtype ?? null,
    accountRole: input.accountRole,
    parentBookAccountKey: input.parentBookAccountKey ?? null,
    currencyCode: input.currencyCode ?? null,
    active: input.active ?? true,
    expectedVersion: input.expectedVersion
  })).digest("hex");
}

function isAccountNumberUniqueViolation(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const error = value as { readonly code?: unknown; readonly constraint?: unknown };
  return error.code === "23505" && error.constraint === "reporting_book_accounts_number_uidx";
}

async function assertBookAccountAcyclic(
  client: import("./postgres-storage.js").PostgresQueryClient,
  tenantId: string,
  companyId: string,
  bookId: string,
  changedKey: string
): Promise<void> {
  const result = await client.query(
    `select "book_account_key", "parent_book_account_key" from "erp_financials"."reporting_book_accounts"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3`,
    [tenantId, companyId, bookId]
  );
  const parents = new Map(result.rows.map((row) => [
    stringField(row, "book_account_key"),
    optionalStringField(row, "parent_book_account_key")
  ]));
  const visited = new Set<string>();
  let current: string | undefined = changedKey;
  while (current !== undefined) {
    if (visited.has(current)) {
      throw new ErpFinancialsError("invalid_account_hierarchy", `Reporting-book account hierarchy contains a cycle at ${current}`);
    }
    visited.add(current);
    current = parents.get(current);
  }
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20)}`;
}

function assertOperation(value: FinancialOperationContext): void {
  try {
    assertFinancialOperationContext(value);
  } catch (cause) {
    throw new ErpFinancialsError("authorization_context_invalid", "Financial operation context is invalid", { cause });
  }
}

function assertBasis(value: string): asserts value is AccountingBasis {
  if (!new Set(["accrual", "cash", "modified_cash"]).has(value)) {
    throw new ErpFinancialsError("invalid_input", `Unsupported accounting basis ${value}`);
  }
}

function assertClassification(value: string): asserts value is AccountClassification {
  if (!new Set(["asset", "liability", "equity", "income", "cost_of_goods_sold", "expense", "other_income", "other_expense"]).has(value)) {
    throw new ErpFinancialsError("invalid_input", `Unsupported account classification ${value}`);
  }
}

function assertAccountRole(value: string): asserts value is ReportingBookAccountRole {
  if (value !== "header" && value !== "posting") {
    throw new ErpFinancialsError("invalid_input", "accountRole must be header or posting");
  }
}

function assertExpectedVersion(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ErpFinancialsError("invalid_input", "expectedVersion must be a nonnegative integer");
  }
}

function assertWindow(from: IsoDate | undefined, through: IsoDate | undefined): void {
  if (from !== undefined) assertDate(from, "effectiveFrom");
  if (through !== undefined) assertDate(through, "effectiveThrough");
  if (from !== undefined && through !== undefined && from > through) {
    throw new ErpFinancialsError("invalid_input", "effectiveFrom must be on or before effectiveThrough");
  }
}

function assertDate(value: string, field: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ErpFinancialsError("invalid_input", `${field} must be a valid ISO date`);
  }
}

function assertCurrency(value: string, field: string): void {
  if (!/^[A-Z]{3}$/u.test(value)) {
    throw new ErpFinancialsError("invalid_input", `${field} must be a three-letter uppercase ISO currency code`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ErpFinancialsError("invalid_input", `${field} must not be empty`);
  }
}

function requiredRow<Row>(row: Row | undefined, label: string): Row {
  if (row === undefined) throw new Error(`${label} write did not return a row`);
  return row;
}

function stringField(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Stored ${field} must be a non-empty string`);
  return value;
}

function optionalStringField(row: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  return stringField(row, field);
}

function reportingBookAccountRoleField(
  row: Readonly<Record<string, unknown>>,
  field: string
): ReportingBookAccountRole {
  const value = stringField(row, field);
  if (value !== "header" && value !== "posting") throw new Error(`Stored ${field} must be header or posting`);
  return value;
}

function integerField(row: Readonly<Record<string, unknown>>, field: string): number {
  const value = row[field];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Stored ${field} must be a nonnegative integer`);
  return parsed;
}

function dateTimeField(row: Readonly<Record<string, unknown>>, field: string): IsoDateTime {
  const value = row[field];
  const result = value instanceof Date ? value.toISOString() : stringField(row, field);
  if (Number.isNaN(Date.parse(result))) throw new Error(`Stored ${field} must be a date-time`);
  return result;
}

function optionalDateField(row: Readonly<Record<string, unknown>>, field: string): IsoDate | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString().slice(0, 10) : stringField(row, field);
}
