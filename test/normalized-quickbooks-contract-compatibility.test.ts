import { describe, expect, it } from "vitest";

import {
  assertReportBuilderInputComplete,
  mapHandrailQuickBooksSdkResourcesToCanonicalFacts,
  mapHandrailQuickBooksSdkResourcesToJournalEntryInput
} from "../src/index.js";

import type {
  CanonicalAccountingFactSet,
  HandrailQuickBooksAccountResource,
  HandrailQuickBooksCompanyInfoResource,
  HandrailQuickBooksJournalEntryResource,
  HandrailQuickBooksSdkResourcesAdapterInput,
  NormalizedQuickBooksAccount,
  NormalizedQuickBooksCompanyInfo,
  NormalizedQuickBooksLedgerEntryResource,
  NormalizedQuickBooksLedgerLine,
  NormalizedQuickBooksLedgerPosting,
  NormalizedQuickBooksResourceSet,
  QuickBooksAdapterContext,
  QuickBooksSdkAccount,
  QuickBooksSdkCompanyInfo,
  QuickBooksSdkJournalEntryLine,
  ReportBuilderInput,
  SafeSourcePayloadRef
} from "../src/index.js";

describe("normalized QuickBooks contract compatibility", () => {
  it("transforms normalized QuickBooks resources into the ERP Financials adapter input shape", () => {
    const normalizedResources = normalizedQuickBooksContractFixture();
    const adapterInput = normalizedQuickBooksResourceSetToAdapterInput(normalizedResources);
    const journalEntryInput = mapHandrailQuickBooksSdkResourcesToJournalEntryInput(adapterInput);
    const facts = mapHandrailQuickBooksSdkResourcesToCanonicalFacts(adapterInput);

    expect(journalEntryInput.companyInfo).toEqual({
      CompanyName: "Normalized QBO Co",
      LegalName: "Normalized QuickBooks Company LLC",
      FiscalYearStartMonth: 1
    });
    expect(journalEntryInput.accounts.map((account) => account.Id)).toEqual(["35", "79"]);
    expect(journalEntryInput.accounts.find((account) => account.Id === "79")?.ParentRef?.value).toBe("35");
    expect(journalEntryInput.journalEntries[0]?.Id).toBe("100");
    expect(journalEntryInput.journalEntries[0]?.Line[0]?.JournalEntryLineDetail.AccountRef.value).toBe("35");
    expect(journalEntryInput.journalEntries[0]?.Line[0]?.sourcePayloadRef?.storageRef).toBe(
      "quickbooks-sdk://sandbox/realm/123145999999999/JournalEntryLine/100:1"
    );

    expect(adapterInput.resources.importBatch?.importBatchId).toBe("batch_normalized_qbo_1");
    expect(adapterInput.resources.checkpoint?.checkpointId).toBe("checkpoint_normalized_qbo_1");
    expect(facts.importBatch.importBatchId).toBe("batch_normalized_qbo_1");
    expect(facts.checkpoint.checkpointId).toBe("checkpoint_normalized_qbo_1");
    expect(facts.checkpoint.latestSourceUpdatedAt).toBe("2026-02-01T10:00:00.000Z");
    expect(facts.postings.map((posting) => posting.checkpointId)).toEqual([
      "checkpoint_normalized_qbo_1",
      "checkpoint_normalized_qbo_1"
    ]);
    const parentAccount = facts.accounts.find((account) => account.sourceAccountId === "35");
    const childAccount = facts.accounts.find((account) => account.sourceAccountId === "79");
    expect(parentAccount).toBeDefined();
    expect(childAccount).toBeDefined();
    expect(parentAccount?.parentAccountId).toBeUndefined();
    expect(childAccount?.parentAccountId).toBe(parentAccount?.accountId);

    const reportBuilderInput = reportBuilderInputFromFacts(facts);
    assertReportBuilderInputComplete(reportBuilderInput);
    expect(reportBuilderInput.accounts).toEqual(facts.accounts);
    const reportBuilderChildAccount = reportBuilderInput.accounts.find((account) => account.accountId === childAccount?.accountId);
    expect(reportBuilderChildAccount?.parentAccountId).toBe(parentAccount?.accountId);
    expect(JSON.stringify(reportBuilderInput)).not.toMatch(/parentAccountRef|ParentRef/);
    expect(JSON.stringify([normalizedResources, adapterInput, journalEntryInput, facts])).not.toMatch(
      /access[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|rawPayload/i
    );
  });

  it("keeps credential fields out of normalized QuickBooks resource types", () => {
    const credentialFieldExclusionChecks = [
      true,
      true,
      true,
      true,
      true
    ] satisfies [
      CredentialFieldsAbsent<NormalizedQuickBooksResourceSet>,
      CredentialFieldsAbsent<NormalizedQuickBooksCompanyInfo>,
      CredentialFieldsAbsent<NormalizedQuickBooksAccount>,
      CredentialFieldsAbsent<NormalizedQuickBooksLedgerPosting>,
      CredentialFieldsAbsent<NormalizedQuickBooksLedgerLine>
    ];

    expect(credentialFieldExclusionChecks).toEqual([true, true, true, true, true]);
  });
});

type ForbiddenCredentialField =
  | "token"
  | "tokens"
  | "accessToken"
  | "access_token"
  | "refreshToken"
  | "refresh_token"
  | "clientSecret"
  | "client_secret"
  | "clientSecrets"
  | "rawPayload"
  | "rawProviderPayload";

type CredentialFieldsAbsent<Resource> = Extract<keyof Resource, ForbiddenCredentialField> extends never ? true : never;

function normalizedQuickBooksResourceSetToAdapterInput(
  resources: NormalizedQuickBooksResourceSet
): HandrailQuickBooksSdkResourcesAdapterInput {
  const context: QuickBooksAdapterContext = {
    tenantId: resources.identity.tenantId,
    companyId: `company_${resources.identity.realmId}`,
    sourceId: resources.identity.sourceId,
    realmId: resources.identity.realmId,
    providerEnvironment: resources.identity.providerEnvironment,
    importBatchId: resources.importBatch?.importBatchId ?? resources.companyInfo.importBatchId ?? "batch_missing",
    checkpointId: resources.checkpoint?.checkpointId ?? resources.companyInfo.checkpointId ?? "checkpoint_missing",
    accountingBasis: "accrual",
    defaultCurrencyCode: resources.companyInfo.resource.baseCurrencyCode ?? "USD",
    importedAt: resources.importBatch?.completedAt ?? resources.importBatch?.startedAt ?? "2026-02-01T10:05:00.000Z",
    ...(resources.checkpoint?.freshThrough === undefined ? {} : { freshThrough: resources.checkpoint.freshThrough }),
    ...(resources.checkpoint?.latestSourceUpdatedAt === undefined
      ? {}
      : { latestSourceUpdatedAt: resources.checkpoint.latestSourceUpdatedAt }),
    runtimeConfig: {
      serviceEnvironment: "staging",
      providerMode: resources.identity.providerEnvironment,
      tenantId: resources.identity.tenantId
    }
  };

  return {
    context,
    resources: {
      identity: resources.identity,
      ...(resources.importBatch === undefined ? {} : { importBatch: resources.importBatch }),
      ...(resources.checkpoint === undefined ? {} : { checkpoint: resources.checkpoint }),
      companyInfo: normalizedCompanyInfoToSdkResource(resources.companyInfo),
      accounts: resources.accounts.map(normalizedAccountToSdkResource),
      journalEntries: (resources.journalEntries ?? []).map(normalizedJournalEntryToSdkResource),
      ledgerTransactions: resources.ledgerTransactions ?? [],
      ledgerPostings: resources.ledgerPostings ?? [],
      providerReports: resources.providerReports ?? [],
      reconciliationEvidence: resources.reconciliationEvidence ?? []
    }
  };
}

function normalizedCompanyInfoToSdkResource(
  resource: NormalizedQuickBooksResourceSet["companyInfo"]
): HandrailQuickBooksCompanyInfoResource {
  const companyInfo: QuickBooksSdkCompanyInfo = {
    ...(resource.resource.companyName === undefined ? {} : { CompanyName: resource.resource.companyName }),
    ...(resource.resource.legalName === undefined ? {} : { LegalName: resource.resource.legalName }),
    ...(resource.resource.fiscalYearStartMonth === undefined ? {} : { FiscalYearStartMonth: resource.resource.fiscalYearStartMonth })
  };

  return {
    ...resource,
    resource: companyInfo
  };
}

function normalizedAccountToSdkResource(resource: NormalizedQuickBooksResourceSet["accounts"][number]): HandrailQuickBooksAccountResource {
  const account: QuickBooksSdkAccount = {
    Id: resource.resource.sourceAccountId,
    Name: resource.resource.name,
    AccountType: resource.resource.accountType,
    ...(resource.resource.parentAccountRef === undefined
      ? {}
      : {
          ParentRef: {
            value: resource.resource.parentAccountRef.sourceObjectId,
            ...(resource.resource.parentAccountRef.displayName === undefined ? {} : { name: resource.resource.parentAccountRef.displayName })
          }
        }),
    ...(resource.resource.accountNumber === undefined ? {} : { AcctNum: resource.resource.accountNumber }),
    ...(resource.resource.accountSubType === undefined ? {} : { AccountSubType: resource.resource.accountSubType }),
    ...(resource.resource.active === undefined ? {} : { Active: resource.resource.active }),
    ...(resource.resource.currencyCode === undefined ? {} : { CurrencyRef: { value: resource.resource.currencyCode } })
  };

  return {
    ...resource,
    resource: account
  };
}

function normalizedJournalEntryToSdkResource(resource: NormalizedQuickBooksLedgerEntryResource): HandrailQuickBooksJournalEntryResource {
  const journalEntry = resource.resource;
  const lineSourcePayloadRefs = Object.fromEntries(
    journalEntry.lines.flatMap((line) => {
      const sourcePayloadRef = line.sourcePayloadRef ?? line.postings[0]?.sourcePayloadRef;
      return sourcePayloadRef === undefined ? [] : [[line.sourceLineId ?? String(line.lineNumber), sourcePayloadRef]];
    })
  ) as Readonly<Record<string, SafeSourcePayloadRef>>;

  return {
    ...resource,
    resource: {
      Id: journalEntry.sourceTransactionId,
      TxnDate: journalEntry.transactionDate,
      ...(journalEntry.transactionNumber === undefined ? {} : { DocNumber: journalEntry.transactionNumber }),
      ...(journalEntry.memo === undefined ? {} : { PrivateNote: journalEntry.memo }),
      ...(journalEntry.currencyCode === undefined ? {} : { CurrencyRef: { value: journalEntry.currencyCode } }),
      ...(journalEntry.sourceUpdatedAt === undefined ? {} : { MetaData: { LastUpdatedTime: journalEntry.sourceUpdatedAt } }),
      Line: journalEntry.lines.map(normalizedLineToSdkLine),
      ...(journalEntry.sourcePayloadRef === undefined ? {} : { sourcePayloadRef: journalEntry.sourcePayloadRef })
    },
    ...(Object.keys(lineSourcePayloadRefs).length === 0 ? {} : { lineSourcePayloadRefs })
  };
}

function normalizedLineToSdkLine(line: NormalizedQuickBooksLedgerLine): QuickBooksSdkJournalEntryLine {
  const posting = requireFirstPosting(line);
  const postingType = posting.creditAmount === undefined ? "Debit" : "Credit";
  const amount = posting.creditAmount ?? posting.debitAmount ?? absoluteDecimal(posting.netAmount ?? line.amount ?? "0.00");
  const accountRef = line.accountRef ?? posting.accountRef;
  const classRef = line.dimensionRefs?.find((ref) => ref.dimensionKind === "class");
  const departmentRef = line.dimensionRefs?.find((ref) => ref.dimensionKind === "department");

  return {
    Id: line.sourceLineId ?? String(line.lineNumber),
    LineNum: line.lineNumber,
    ...(line.description === undefined ? {} : { Description: line.description }),
    Amount: amount,
    JournalEntryLineDetail: {
      PostingType: postingType,
      AccountRef: {
        value: accountRef.sourceObjectId,
        ...(accountRef.displayName === undefined ? {} : { name: accountRef.displayName })
      },
      ...(classRef === undefined
        ? {}
        : { ClassRef: { value: classRef.sourceObjectId, ...(classRef.displayName === undefined ? {} : { name: classRef.displayName }) } }),
      ...(departmentRef === undefined
        ? {}
        : {
            DepartmentRef: {
              value: departmentRef.sourceObjectId,
              ...(departmentRef.displayName === undefined ? {} : { name: departmentRef.displayName })
            }
          })
    },
    ...(line.sourcePayloadRef === undefined ? {} : { sourcePayloadRef: line.sourcePayloadRef })
  };
}

function requireFirstPosting(line: NormalizedQuickBooksLedgerLine): NormalizedQuickBooksLedgerPosting {
  const posting = line.postings[0];
  if (posting === undefined) {
    throw new Error(`Normalized QuickBooks line ${line.sourceLineId ?? String(line.lineNumber)} must include at least one posting`);
  }
  return posting;
}

function absoluteDecimal(value: string): string {
  return value.startsWith("-") ? value.slice(1) : value;
}

function reportBuilderInputFromFacts(facts: CanonicalAccountingFactSet): ReportBuilderInput {
  return {
    tenantId: facts.company.tenantId,
    companyId: facts.company.companyId,
    sourceId: facts.source.sourceId,
    accounts: facts.accounts,
    postings: facts.postings,
    accountingBasis: "accrual",
    currencyCode: facts.company.baseCurrencyCode,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    asOfDate: "2026-01-31",
    generatedAt: "2026-02-01T11:00:00.000Z",
    freshness: {
      status: "fresh",
      sourceId: facts.source.sourceId,
      importBatchId: facts.importBatch.importBatchId,
      checkpointId: facts.checkpoint.checkpointId,
      ...(facts.checkpoint.freshThrough === undefined ? {} : { freshThrough: facts.checkpoint.freshThrough })
    }
  };
}

function normalizedQuickBooksContractFixture(): NormalizedQuickBooksResourceSet {
  const sourcePayloadRef = (sourceObjectType: string, sourceObjectId: string): SafeSourcePayloadRef => ({
    sourceObjectType,
    sourceObjectId,
    sourceUpdatedAt: "2026-02-01T10:00:00.000Z",
    storageRef: `quickbooks-sdk://sandbox/realm/123145999999999/${sourceObjectType}/${sourceObjectId}`,
    preview: {
      sourceObjectType,
      sourceObjectId
    }
  });

  return {
    identity: {
      tenantId: "tenant_normalized",
      sourceId: "source_qbo_normalized",
      sourceSystem: "quickbooks",
      providerEnvironment: "sandbox",
      realmId: "123145999999999",
      sourceCompanyRef: "123145999999999"
    },
    importBatch: {
      importBatchId: "batch_normalized_qbo_1",
      syncMode: "incremental",
      mode: "delta",
      status: "completed",
      startedAt: "2026-02-01T10:00:00.000Z",
      completedAt: "2026-02-01T10:05:00.000Z",
      sourceObjectCounts: {
        companyInfo: 1,
        accounts: 2,
        journalEntries: 1,
        ledgerPostings: 2
      }
    },
    checkpoint: {
      checkpointId: "checkpoint_normalized_qbo_1",
      sourceObject: "ledger_transactions",
      cursorKind: "updated_since",
      cursorValue: "2026-02-01T10:00:00.000Z",
      freshThrough: "2026-02-01T10:00:00.000Z",
      latestSourceUpdatedAt: "2026-02-01T10:00:00.000Z",
      status: "current"
    },
    companyInfo: {
      sourceSystem: "quickbooks",
      tenantId: "tenant_normalized",
      sourceId: "source_qbo_normalized",
      providerEnvironment: "sandbox",
      realmId: "123145999999999",
      resourceType: "CompanyInfo",
      resourceId: "123145999999999",
      importBatchId: "batch_normalized_qbo_1",
      checkpointId: "checkpoint_normalized_qbo_1",
      resource: {
        companyName: "Normalized QBO Co",
        legalName: "Normalized QuickBooks Company LLC",
        baseCurrencyCode: "USD",
        fiscalYearStartMonth: 1
      }
    },
    accounts: [
      {
        sourceSystem: "quickbooks",
        tenantId: "tenant_normalized",
        sourceId: "source_qbo_normalized",
        providerEnvironment: "sandbox",
        realmId: "123145999999999",
        resourceType: "Account",
        resourceId: "35",
        importBatchId: "batch_normalized_qbo_1",
        checkpointId: "checkpoint_normalized_qbo_1",
        sourceUpdatedAt: "2026-02-01T10:00:00.000Z",
        sourcePayloadRef: sourcePayloadRef("Account", "35"),
        resource: {
          sourceAccountId: "35",
          name: "Checking",
          accountNumber: "1000",
          accountType: "Bank",
          accountSubType: "Checking",
          classification: "asset",
          active: true,
          currencyCode: "USD",
          sourcePayloadRef: sourcePayloadRef("Account", "35")
        }
      },
      {
        sourceSystem: "quickbooks",
        tenantId: "tenant_normalized",
        sourceId: "source_qbo_normalized",
        providerEnvironment: "sandbox",
        realmId: "123145999999999",
        resourceType: "Account",
        resourceId: "79",
        importBatchId: "batch_normalized_qbo_1",
        checkpointId: "checkpoint_normalized_qbo_1",
        resource: {
          sourceAccountId: "79",
          parentAccountRef: {
            sourceObjectId: "35",
            displayName: "Checking"
          },
          name: "Services",
          accountNumber: "4000",
          accountType: "Income",
          accountSubType: "ServiceFeeIncome",
          classification: "income",
          active: true,
          currencyCode: "USD"
        }
      }
    ],
    journalEntries: [
      {
        sourceSystem: "quickbooks",
        tenantId: "tenant_normalized",
        sourceId: "source_qbo_normalized",
        providerEnvironment: "sandbox",
        realmId: "123145999999999",
        resourceType: "JournalEntry",
        resourceId: "100",
        importBatchId: "batch_normalized_qbo_1",
        checkpointId: "checkpoint_normalized_qbo_1",
        sourceUpdatedAt: "2026-02-01T10:00:00.000Z",
        sourcePayloadRef: sourcePayloadRef("JournalEntry", "100"),
        resource: {
          sourceTransactionId: "100",
          sourceTransactionType: "JournalEntry",
          transactionDate: "2026-01-15",
          transactionNumber: "JE-100",
          sourceUpdatedAt: "2026-02-01T10:00:00.000Z",
          currencyCode: "USD",
          memo: "Recognize services revenue",
          sourcePayloadRef: sourcePayloadRef("JournalEntry", "100"),
          lines: [
            {
              sourceLineId: "1",
              lineNumber: 1,
              description: "Cash received",
              amount: "500.00",
              accountRef: {
                sourceObjectId: "35",
                displayName: "Checking"
              },
              dimensionRefs: [
                {
                  dimensionKind: "department",
                  sourceObjectId: "ops",
                  displayName: "Operations"
                }
              ],
              sourcePayloadRef: sourcePayloadRef("JournalEntryLine", "100:1"),
              postings: [
                {
                  sourcePostingId: "100:1",
                  accountRef: {
                    sourceObjectId: "35",
                    displayName: "Checking"
                  },
                  postingDate: "2026-01-15",
                  accountingBasis: "accrual",
                  debitAmount: "500.00",
                  currencyCode: "USD",
                  sourcePayloadRef: sourcePayloadRef("JournalEntryLine", "100:1")
                }
              ]
            },
            {
              sourceLineId: "2",
              lineNumber: 2,
              description: "Services revenue",
              amount: "-500.00",
              accountRef: {
                sourceObjectId: "79",
                displayName: "Services"
              },
              dimensionRefs: [
                {
                  dimensionKind: "class",
                  sourceObjectId: "services",
                  displayName: "Services"
                }
              ],
              sourcePayloadRef: sourcePayloadRef("JournalEntryLine", "100:2"),
              postings: [
                {
                  sourcePostingId: "100:2",
                  accountRef: {
                    sourceObjectId: "79",
                    displayName: "Services"
                  },
                  postingDate: "2026-01-15",
                  accountingBasis: "accrual",
                  creditAmount: "500.00",
                  currencyCode: "USD",
                  sourcePayloadRef: sourcePayloadRef("JournalEntryLine", "100:2")
                }
              ]
            }
          ]
        }
      }
    ]
  };
}
