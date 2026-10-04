import { describe, expect, it } from "vitest";

import {
  ERP_FINANCIALS_QUICKBOOKS_ADAPTER_FIXTURE,
  buildProfitAndLossReport,
  buildTrialBalanceReport,
  mapHandrailQuickBooksSdkResourcesToCanonicalFacts,
  mapHandrailQuickBooksSdkResourcesToJournalEntryInput,
  mapNativeLedgerToCanonicalFacts,
  mapQuickBooksJournalEntriesToCanonicalFacts
} from "../src/index.js";

import type {
  CanonicalAccountingFactSet,
  HandrailQuickBooksSdkResourceSet,
  HandrailQuickBooksSdkResourcesAdapterInput,
  NativeLedgerAdapterInput,
  NormalizedQuickBooksBackfillSyncRequestEnvelope,
  NormalizedQuickBooksCheckpointResumeRequestEnvelope,
  NormalizedQuickBooksFullSyncRequestEnvelope,
  NormalizedQuickBooksIncrementalSyncResponseEnvelope,
  NormalizedQuickBooksLedgerTransactionResource,
  NormalizedQuickBooksPaginationRequestEnvelope,
  NormalizedQuickBooksPaginationResponseEnvelope,
  NormalizedQuickBooksReprocessSyncRequestEnvelope,
  NormalizedQuickBooksResourceSet,
  QuickBooksJournalEntryAdapterInput,
  ReportBuilderInput,
  SafeSourcePayloadRef,
  SourceAdapterContext
} from "../src/index.js";

describe("source adapter contracts", () => {
  it("maps QuickBooks-shaped SDK data into canonical postings for the shared report builders", () => {
    const facts = mapQuickBooksJournalEntriesToCanonicalFacts(quickBooksFixtureInput());
    const profitAndLoss = buildProfitAndLossReport(reportInput(facts));
    const trialBalance = buildTrialBalanceReport(reportInput(facts));

    expect(totalAmount(profitAndLoss, "total_income")).toBe("500.00");
    expect(totalAmount(profitAndLoss, "net_income")).toBe("500.00");
    expect(totalAmount(trialBalance, "total_debits")).toBe("500.00");
    expect(totalAmount(trialBalance, "total_credits")).toBe("500.00");

    expect(facts.source.sourceSystem).toBe("quickbooks");
    expect(facts.source.providerEnvironment).toBe("sandbox");
    expect(facts.source.connectionRef).toBe("handrail-quickbooks-sdk:staging:sandbox:realm:123145999999999");
    expect(facts.company.sourceCompanyRef).toBe("123145999999999");
    expect(facts.importBatch.importBatchId).toBe("batch_qbo_1");
    expect(facts.checkpoint.checkpointId).toBe("checkpoint_qbo_1");

    const cashPosting = postingByAccountName(facts, "Checking");
    expect(cashPosting.importBatchId).toBe("batch_qbo_1");
    expect(cashPosting.checkpointId).toBe("checkpoint_qbo_1");
    expect(cashPosting.sourcePostingId).toBe("100:1");
    expect(cashPosting.sourcePayloadRef?.sourceObjectType).toBe("JournalEntryLine");
    expect(cashPosting.sourcePayloadRef?.sourceObjectId).toBe("100:1");
    expect(cashPosting.sourcePayloadRef?.sourceUpdatedAt).toBe("2026-02-01T10:00:00.000Z");
    expect(cashPosting.sourcePayloadRef?.storageRef).toBe("quickbooks://sandbox/realm/123145999999999/JournalEntryLine/100:1");
    expect(JSON.stringify(facts)).not.toMatch(/access[_-]?token|refresh[_-]?token|client_secret/i);
  });

  it("keeps QuickBooks COGS account subtypes in the P&L COGS section", () => {
    const input = quickBooksFixtureInput();
    if (input.accounts[0] === undefined) throw new Error("Missing fixture account");
    const facts = mapQuickBooksJournalEntriesToCanonicalFacts({
      ...input,
      accounts: [
        input.accounts[0],
        {
          Id: "79",
          Name: "Product Sales",
          AcctNum: "4000",
          AccountType: "Income",
          AccountSubType: "SalesOfProductIncome",
          Active: true,
          CurrencyRef: {
            value: "USD"
          }
        },
        {
          Id: "80",
          Name: "Materials COGS",
          AcctNum: "5000",
          AccountType: "Expense",
          AccountSubType: "SuppliesMaterialsCogs",
          Classification: "expense",
          Active: true,
          CurrencyRef: {
            value: "USD"
          }
        },
        {
          Id: "81",
          Name: "Rent Expense",
          AcctNum: "6100",
          AccountType: "Expense",
          AccountSubType: "RentOrLeaseOfBuildings",
          Active: true,
          CurrencyRef: {
            value: "USD"
          }
        }
      ],
      journalEntries: [
        {
          Id: "101",
          TxnDate: "2026-01-16",
          DocNumber: "JE-101",
          PrivateNote: "QuickBooks P&L fixture with COGS",
          CurrencyRef: {
            value: "USD"
          },
          Line: [
            qboJournalLine("1", 1, "Cash from product sale", "1000.00", "Debit", "35", "Checking"),
            qboJournalLine("2", 2, "Product sales", "1000.00", "Credit", "79", "Product Sales"),
            qboJournalLine("3", 3, "Materials COGS", "300.00", "Debit", "80", "Materials COGS"),
            qboJournalLine("4", 4, "Cash paid for materials", "300.00", "Credit", "35", "Checking"),
            qboJournalLine("5", 5, "Rent expense", "200.00", "Debit", "81", "Rent Expense"),
            qboJournalLine("6", 6, "Cash paid for rent", "200.00", "Credit", "35", "Checking")
          ]
        }
      ]
    });
    const profitAndLoss = buildProfitAndLossReport(reportInput(facts));

    expect(accountByName(facts, "Materials COGS").classification).toBe("cost_of_goods_sold");
    expect(profitAndLoss.lines.map((line) => [line.section, line.label, line.amount])).toEqual([
      ["income", "4000 Product Sales", "1000.00"],
      ["cost_of_goods_sold", "5000 Materials COGS", "300.00"],
      ["expense", "6100 Rent Expense", "200.00"]
    ]);
    expect(totalAmount(profitAndLoss, "total_income")).toBe("1000.00");
    expect(totalAmount(profitAndLoss, "total_cost_of_goods_sold")).toBe("300.00");
    expect(totalAmount(profitAndLoss, "gross_profit")).toBe("700.00");
    expect(totalAmount(profitAndLoss, "total_expenses")).toBe("200.00");
    expect(totalAmount(profitAndLoss, "net_income")).toBe("500.00");
  });

  it("maps normalized Handrail QuickBooks SDK resources into the canonical QuickBooks adapter input", () => {
    const adapterInput = mapHandrailQuickBooksSdkResourcesToJournalEntryInput(quickBooksSdkResourcesFixtureInput());

    expect(adapterInput.companyInfo.CompanyName).toBe("Adapter QBO Co");
    expect(adapterInput.accounts.map((account) => account.Id)).toEqual(["35", "79"]);
    expect(adapterInput.journalEntries[0]?.sourcePayloadRef?.storageRef).toBe(
      "quickbooks-sdk://sandbox/realm/123145999999999/JournalEntry/100"
    );
    expect(adapterInput.journalEntries[0]?.Line[0]?.sourcePayloadRef?.storageRef).toBe(
      "quickbooks-sdk://sandbox/realm/123145999999999/JournalEntryLine/100:1"
    );
  });

  it("maps normalized Handrail QuickBooks SDK resources directly to canonical facts", () => {
    const facts = mapHandrailQuickBooksSdkResourcesToCanonicalFacts(quickBooksSdkResourcesFixtureInput());
    const trialBalance = buildTrialBalanceReport(reportInput(facts));

    expect(facts.source.connectionRef).toBe("handrail-quickbooks-sdk:staging:sandbox:realm:123145999999999");
    expect(totalAmount(trialBalance, "total_debits")).toBe("500.00");

    const cashPosting = postingByAccountName(facts, "Checking");
    expect(cashPosting.sourcePayloadRef?.sourceObjectType).toBe("JournalEntryLine");
    expect(cashPosting.sourcePayloadRef?.sourceObjectId).toBe("100:1");
    expect(cashPosting.sourcePayloadRef?.storageRef).toBe(
      "quickbooks://sandbox/realm/123145999999999/JournalEntryLine/100:1"
    );
    expect(JSON.stringify(facts)).not.toMatch(/access[_-]?token|refresh[_-]?token|client_secret/i);
  });

  it("preserves reference masters in normalized batches with no ledger transactions", () => {
    const input = quickBooksNormalizedLedgerTransactionsFixtureInput();
    const resourceBase = {
      sourceSystem: "quickbooks" as const,
      providerEnvironment: input.context.providerEnvironment,
      realmId: input.context.realmId
    };
    const facts = mapHandrailQuickBooksSdkResourcesToCanonicalFacts({
      ...input,
      resources: {
        ...input.resources,
        ledgerTransactions: [],
        items: [{
          ...resourceBase,
          resourceType: "Item",
          resourceId: "item-services",
          resource: {
            sourceObjectId: "item-services",
            name: "Managed services",
            active: true
          }
        }],
        parties: [{
          ...resourceBase,
          resourceType: "Party",
          resourceId: "customer-1",
          resource: {
            sourceObjectId: "customer-1",
            partyType: "customer",
            displayName: "Customer One",
            active: true
          }
        }]
      }
    });

    expect(facts.transactions).toEqual([]);
    expect(facts.items.map((item) => item.sourceItemId)).toEqual(["item-services"]);
    expect(facts.parties.map((party) => party.sourcePartyId)).toEqual(["customer-1"]);
  });

  it("maps normalized QuickBooks ledger transactions for JournalEntry and Invoice without raw transaction payloads", () => {
    const facts = mapHandrailQuickBooksSdkResourcesToCanonicalFacts(quickBooksNormalizedLedgerTransactionsFixtureInput());
    const trialBalance = buildTrialBalanceReport(reportInput(facts));

    expect(facts.transactions.map((transaction) => [transaction.sourceTransactionId, transaction.sourceTransactionType])).toEqual([
      ["100", "JournalEntry"],
      ["200", "Invoice"]
    ]);
    expect(totalAmount(trialBalance, "total_debits")).toBe("1200.00");
    expect(totalAmount(trialBalance, "total_credits")).toBe("1200.00");

    const invoicePosting = facts.postings.find((posting) => posting.sourcePostingId === "200:ar");
    expect(invoicePosting?.sourcePayloadRef?.sourceObjectType).toBe("InvoiceLine");
    expect(invoicePosting?.sourcePayloadRef?.storageRef).toBe("quickbooks-sdk://sandbox/realm/123145999999999/InvoiceLine/200:ar");
    expect(facts.transactions.find((transaction) => transaction.sourceTransactionId === "200")?.sourcePayloadRef?.sourceObjectType).toBe(
      "Invoice"
    );
    expect(JSON.stringify(facts)).not.toMatch(/access[_-]?token|refresh[_-]?token|client_secret|rawPayload/i);
  });

  it("preserves historical QuickBooks party references missing from customer and vendor masters", () => {
    const input = quickBooksNormalizedLedgerTransactionsFixtureInput();
    const invoice = input.resources.ledgerTransactions?.find((transaction) => transaction.resource.sourceTransactionId === "200");
    expect(invoice).toBeDefined();
    if (invoice === undefined) {
      return;
    }
    const historicalEmployee = {
      sourceObjectId: "employee-3",
      displayName: "Historical Employee",
      partyType: "other" as const
    };
    const ledgerTransactions: readonly NormalizedQuickBooksLedgerTransactionResource[] = [
      ...(input.resources.ledgerTransactions ?? []).filter((transaction) => transaction !== invoice),
      {
        ...invoice,
        resource: {
          ...invoice.resource,
          partyRef: historicalEmployee,
          lines: invoice.resource.lines.map((line) => ({
            ...line,
            partyRef: historicalEmployee,
            postings: line.postings.map((posting) => ({ ...posting, partyRef: historicalEmployee }))
          }))
        }
      }
    ];

    const facts = mapHandrailQuickBooksSdkResourcesToCanonicalFacts({
      ...input,
      resources: { ...input.resources, ledgerTransactions }
    });
    const party = facts.parties.find((candidate) => candidate.sourcePartyId === "employee-3");
    const transaction = facts.transactions.find((candidate) => candidate.sourceTransactionId === "200");

    expect(party).toMatchObject({
      sourcePartyId: "employee-3",
      partyType: "other",
      displayName: "Historical Employee",
      active: false
    });
    expect(transaction?.partyId).toBe(party?.partyId);
    expect(facts.transactionLines.filter((line) => line.transactionId === transaction?.transactionId).every((line) => line.partyId === party?.partyId)).toBe(true);
    expect(facts.postings.filter((posting) => posting.transactionId === transaction?.transactionId).every((posting) => posting.partyId === party?.partyId)).toBe(true);
  });

  it("exports normalized QuickBooks resource contracts beyond journal entries", () => {
    const input = quickBooksFixtureInput();
    const normalizedResourceSet: NormalizedQuickBooksResourceSet = {
      identity: {
        tenantId: input.context.tenantId,
        sourceId: input.context.sourceId,
        sourceSystem: "quickbooks",
        providerEnvironment: input.context.providerEnvironment,
        realmId: input.context.realmId,
        sourceCompanyRef: input.context.realmId
      },
      importBatch: {
        importBatchId: input.context.importBatchId,
        syncMode: "incremental",
        mode: "delta",
        status: "completed",
        sourceObjectCounts: {
          accounts: 2,
          ledgerTransactions: 1,
          ledgerPostings: 2
        }
      },
      checkpoint: {
        checkpointId: input.context.checkpointId,
        sourceObject: "ledger_transactions",
        cursorKind: "updated_since",
        cursorValue: input.context.latestSourceUpdatedAt ?? input.context.importedAt,
        latestSourceUpdatedAt: input.context.latestSourceUpdatedAt ?? input.context.importedAt,
        status: "current"
      },
      companyInfo: {
        sourceSystem: "quickbooks",
        providerEnvironment: input.context.providerEnvironment,
        realmId: input.context.realmId,
        resourceType: "CompanyInfo",
        resourceId: input.context.realmId,
        resource: {
          companyName: "Adapter QBO Co",
          legalName: "Adapter QuickBooks Company LLC",
          baseCurrencyCode: "USD",
          fiscalYearStartMonth: 1
        }
      },
      accounts: [
        {
          sourceSystem: "quickbooks",
          providerEnvironment: input.context.providerEnvironment,
          realmId: input.context.realmId,
          resourceType: "Account",
          resourceId: "35",
          resource: {
            sourceAccountId: "35",
            name: "Checking",
            accountNumber: "1000",
            accountType: "Bank",
            accountSubType: "Checking",
            classification: "asset",
            active: true,
            currencyCode: "USD"
          }
        }
      ],
      ledgerTransactions: [
        {
          sourceSystem: "quickbooks",
          providerEnvironment: input.context.providerEnvironment,
          realmId: input.context.realmId,
          resourceType: "LedgerTransaction",
          resourceId: "100",
          sourceUpdatedAt: "2026-02-01T10:00:00.000Z",
          resource: {
            sourceTransactionId: "100",
            sourceTransactionType: "JournalEntry",
            transactionDate: "2026-01-15",
            transactionNumber: "JE-100",
            sourceUpdatedAt: "2026-02-01T10:00:00.000Z",
            currencyCode: "USD",
            memo: "Recognize services revenue",
            lines: [
              {
                sourceLineId: "1",
                lineNumber: 1,
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
                    currencyCode: "USD"
                  }
                ]
              }
            ]
          }
        }
      ],
      customers: [
        {
          sourceSystem: "quickbooks",
          providerEnvironment: input.context.providerEnvironment,
          realmId: input.context.realmId,
          resourceType: "Customer",
          resourceId: "customer-1",
          resource: {
            sourceObjectId: "customer-1",
            displayName: "Sample Customer",
            partyType: "customer",
            active: true
          }
        }
      ],
      vendors: [
        {
          sourceSystem: "quickbooks",
          providerEnvironment: input.context.providerEnvironment,
          realmId: input.context.realmId,
          resourceType: "Vendor",
          resourceId: "vendor-1",
          resource: {
            sourceObjectId: "vendor-1",
            displayName: "Sample Vendor",
            partyType: "vendor",
            active: true
          }
        }
      ],
      items: [
        {
          sourceSystem: "quickbooks",
          providerEnvironment: input.context.providerEnvironment,
          realmId: input.context.realmId,
          resourceType: "Item",
          resourceId: "service-1",
          resource: {
            sourceObjectId: "service-1",
            displayName: "Implementation",
            itemType: "service",
            name: "Implementation",
            active: true
          }
        }
      ],
      departments: [
        {
          sourceSystem: "quickbooks",
          providerEnvironment: input.context.providerEnvironment,
          realmId: input.context.realmId,
          resourceType: "Department",
          resourceId: "ops",
          resource: {
            dimensionKind: "department",
            sourceObjectId: "ops",
            displayName: "Operations",
            name: "Operations",
            active: true
          }
        }
      ],
      providerReports: [
        {
          provider: "quickbooks",
          providerEnvironment: input.context.providerEnvironment,
          realmId: input.context.realmId,
          reportName: "profit_and_loss",
          accountingBasis: "accrual",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          sourcePayloadRef: {
            sourceObjectType: "Report",
            sourceObjectId: "profit_and_loss:2026-01",
            storageRef: `quickbooks-sdk://sandbox/realm/${input.context.realmId}/Report/profit_and_loss`
          }
        }
      ],
      reconciliationEvidence: [
        {
          provider: "quickbooks",
          providerReportRef: {
            provider: "quickbooks",
            providerEnvironment: input.context.providerEnvironment,
            realmId: input.context.realmId,
            reportName: "profit_and_loss",
            sourcePayloadRef: {
              sourceObjectType: "Report",
              sourceObjectId: "profit_and_loss:2026-01"
            }
          },
          reconciliationStatus: "balanced",
          reconciliationDifference: "0.00",
          totals: [
            {
              totalKey: "net_income",
              canonicalAmount: "500.00",
              providerAmount: "500.00",
              difference: "0.00",
              status: "matched"
            }
          ]
        }
      ]
    };
    const sdkResourceSet: HandrailQuickBooksSdkResourceSet = {
      ...quickBooksSdkResourcesFixtureInput().resources,
      ledgerTransactions: normalizedResourceSet.ledgerTransactions ?? [],
      customers: normalizedResourceSet.customers ?? [],
      vendors: normalizedResourceSet.vendors ?? [],
      items: normalizedResourceSet.items ?? [],
      departments: normalizedResourceSet.departments ?? [],
      providerReports: normalizedResourceSet.providerReports ?? [],
      reconciliationEvidence: normalizedResourceSet.reconciliationEvidence ?? []
    };

    expect(normalizedResourceSet.ledgerTransactions?.[0]?.resource.lines[0]?.postings[0]?.accountRef.sourceObjectId).toBe("35");
    expect(sdkResourceSet.customers?.[0]?.resource.partyType).toBe("customer");
    expect(JSON.stringify(normalizedResourceSet)).not.toMatch(/access[_-]?token|refresh[_-]?token|client_secret|clientSecret/i);
  });

  it("models normalized QuickBooks full, incremental, backfill, reprocess, pagination, and resume envelopes", () => {
    const input = quickBooksFixtureInput();
    const sourceIdentity = {
      tenantId: input.context.tenantId,
      sourceId: input.context.sourceId,
      sourceSystem: "quickbooks" as const,
      providerEnvironment: input.context.providerEnvironment,
      realmId: input.context.realmId,
      sourceCompanyRef: input.context.realmId
    };
    const freshThrough = input.context.freshThrough ?? input.context.importedAt;
    const latestSourceUpdatedAt = input.context.latestSourceUpdatedAt ?? input.context.importedAt;
    const idempotencyKeys = {
      syncRequestKey: "tenant_adapter:source_qbo:incremental:2026-02-01T10:00:00.000Z",
      importBatchId: input.context.importBatchId,
      checkpointId: input.context.checkpointId,
      resourceSetKey: "tenant_adapter:source_qbo:batch_qbo_1:checkpoint_qbo_1"
    };

    const fullRequest: NormalizedQuickBooksFullSyncRequestEnvelope = {
      sourceIdentity,
      syncMode: "full",
      importBatchId: input.context.importBatchId,
      checkpointId: input.context.checkpointId,
      cursorKind: "full_scan",
      cursorValue: "start",
      resourceCounts: {},
      idempotencyKey: idempotencyKeys.syncRequestKey,
      idempotencyKeys,
      requestedResourceTypes: ["CompanyInfo", "Account", "LedgerTransaction"]
    };
    const incrementalResponse: NormalizedQuickBooksIncrementalSyncResponseEnvelope = {
      sourceIdentity,
      providerEnvironment: sourceIdentity.providerEnvironment,
      syncMode: "incremental",
      importBatchId: input.context.importBatchId,
      checkpointId: input.context.checkpointId,
      cursorKind: "updated_since",
      cursorValue: latestSourceUpdatedAt,
      sourceFreshThrough: freshThrough,
      importedThrough: freshThrough,
      freshThrough,
      latestSourceUpdatedAt,
      resourceCounts: {
        accounts: 2,
        ledgerTransactions: 1,
        ledgerPostings: 2
      },
      warningSummary: {
        count: 1,
        items: [
          {
            code: "QBO_MINOR_VERSION_FALLBACK",
            message: "QuickBooks minor version was normalized by the SDK service.",
            severity: "warning"
          }
        ]
      },
      errorSummary: {
        count: 0
      },
      idempotencyKey: idempotencyKeys.syncRequestKey,
      idempotencyKeys,
      status: "completed",
      importBatch: {
        importBatchId: input.context.importBatchId,
        syncMode: "incremental",
        mode: "delta",
        status: "completed",
        sourceObjectCounts: {
          accounts: 2,
          ledgerTransactions: 1,
          ledgerPostings: 2
        }
      },
      checkpoint: {
        checkpointId: input.context.checkpointId,
        sourceObject: "ledger_transactions",
        cursorKind: "updated_since",
        cursorValue: latestSourceUpdatedAt,
        sourceFreshThrough: freshThrough,
        importedThrough: freshThrough,
        freshThrough,
        latestSourceUpdatedAt,
        status: "current"
      },
      resources: {
        identity: sourceIdentity,
        ledgerTransactions: []
      }
    };
    const backfillRequest: NormalizedQuickBooksBackfillSyncRequestEnvelope = {
      ...fullRequest,
      syncMode: "backfill",
      cursorKind: "updated_since",
      cursorValue: "2026-01-01T00:00:00.000Z",
      backfillWindow: {
        transactionDateFrom: "2026-01-01",
        transactionDateTo: "2026-01-31"
      }
    };
    const reprocessRequest: NormalizedQuickBooksReprocessSyncRequestEnvelope = {
      ...fullRequest,
      syncMode: "reprocess",
      cursorKind: "high_watermark",
      cursorValue: "batch_qbo_1",
      reprocessImportBatchId: input.context.importBatchId,
      reprocessCheckpointId: input.context.checkpointId,
      resourceIds: ["JournalEntry:100"]
    };
    const pageRequest: NormalizedQuickBooksPaginationRequestEnvelope<"incremental"> = {
      ...fullRequest,
      syncMode: "incremental",
      cursorKind: "page_token",
      cursorValue: "page:2",
      page: {
        cursorKind: "page_token",
        cursorValue: "page:2",
        pageSize: 250
      }
    };
    const pageResponse: NormalizedQuickBooksPaginationResponseEnvelope<"incremental"> = {
      ...incrementalResponse,
      cursorKind: "page_token",
      cursorValue: "page:2",
      pagination: {
        hasMore: true,
        nextCursor: {
          cursorKind: "page_token",
          cursorValue: "page:3"
        },
        pageSize: 250,
        pageResourceCounts: {
          ledgerTransactions: 250
        }
      }
    };
    const resumeRequest: NormalizedQuickBooksCheckpointResumeRequestEnvelope<"incremental"> = {
      ...pageRequest,
      cursorKind: "updated_since",
      cursorValue: latestSourceUpdatedAt,
      resumeFromCheckpointId: input.context.checkpointId
    };

    expect(fullRequest.syncMode).toBe("full");
    expect(backfillRequest.backfillWindow?.transactionDateTo).toBe("2026-01-31");
    expect(reprocessRequest.reprocessImportBatchId).toBe(input.context.importBatchId);
    expect(pageRequest.page.pageSize).toBe(250);
    expect(pageResponse.pagination.nextCursor?.cursorValue).toBe("page:3");
    expect(resumeRequest.resumeFromCheckpointId).toBe(input.context.checkpointId);
    expect(incrementalResponse.resourceCounts.ledgerPostings).toBe(2);
    expect(incrementalResponse.idempotencyKeys.importBatchId).toBe(input.context.importBatchId);
    expect(JSON.stringify([fullRequest, incrementalResponse, backfillRequest, reprocessRequest, pageRequest, pageResponse, resumeRequest])).not.toMatch(
      /access[_-]?token|refresh[_-]?token|client_secret|clientSecret/i
    );
  });

  it("exports QuickBooks adapter fixture reports with bounded provider parity evidence", () => {
    const fixture = ERP_FINANCIALS_QUICKBOOKS_ADAPTER_FIXTURE;

    expect(fixture.facts.source.sourceSystem).toBe("quickbooks");
    expect(fixture.facts.source.connectionRef).toBe("handrail-quickbooks-sdk:staging:sandbox:realm:123145999999999");
    expect(totalAmount(fixture.reports.profitAndLoss, "net_income")).toBe("500.00");
    expect(fixture.reports.balanceSheet.snapshot.reconciliationStatus).toBe("balanced");
    expect(totalAmount(fixture.reports.trialBalance, "total_debits")).toBe("500.00");

    expect(fixture.providerReportEvidence.map((entry) => entry.reportName)).toEqual([
      "profit_and_loss",
      "balance_sheet",
      "trial_balance"
    ]);
    for (const evidence of fixture.providerReportEvidence) {
      expect(evidence.provider).toBe("quickbooks");
      expect(evidence.reconciliationStatus).toBe("balanced");
      expect(evidence.reconciliationDifference).toBe("0.00");
      expect(evidence.totals.every((total) => total.status === "matched")).toBe(true);
      expect(evidence.totals.every((total) => total.drilldownRef !== undefined)).toBe(true);
      expect(evidence.providerReportRef.storageRef).toBe(
        `quickbooks://sandbox/realm/123145999999999/Report/${evidence.reportName}`
      );
    }
    expect(JSON.stringify(fixture)).not.toMatch(/access[_-]?token|refresh[_-]?token|client_secret/i);
  });

  it("maps native ERP ledger data into the same canonical posting path", () => {
    const facts = mapNativeLedgerToCanonicalFacts(nativeFixtureInput());
    const profitAndLoss = buildProfitAndLossReport(reportInput(facts));
    const trialBalance = buildTrialBalanceReport(reportInput(facts));

    expect(facts.source.sourceSystem).toBe("native_erp");
    expect(facts.source.providerEnvironment).toBe("native");
    expect(totalAmount(profitAndLoss, "total_income")).toBe("500.00");
    expect(totalAmount(profitAndLoss, "net_income")).toBe("500.00");
    expect(totalAmount(trialBalance, "total_debits")).toBe("500.00");
    expect(totalAmount(trialBalance, "total_credits")).toBe("500.00");
    expect(facts.postings.map((posting) => posting.importBatchId)).toEqual(["batch_native_1", "batch_native_1"]);
    expect(facts.postings.map((posting) => posting.checkpointId)).toEqual(["checkpoint_native_1", "checkpoint_native_1"]);
  });

  it("maps native and QuickBooks parent account source references to canonical parent account IDs", () => {
    const nativeInput = nativeFixtureInput();
    const nativeFacts = mapNativeLedgerToCanonicalFacts({
      ...nativeInput,
      accounts: [
        ...nativeInput.accounts,
        {
          sourceAccountId: "services-consulting",
          parentAccountSourceId: "services",
          accountNumber: "4010",
          name: "Consulting Services",
          classification: "income",
          type: "income",
          subtype: "ServiceRevenue",
          currencyCode: "USD"
        }
      ]
    });
    const nativeParent = accountByName(nativeFacts, "Services");
    const nativeChild = accountByName(nativeFacts, "Consulting Services");

    expect(nativeParent.parentAccountId).toBeUndefined();
    expect(nativeChild.parentAccountId).toBe(nativeParent.accountId);

    const quickBooksInput = quickBooksFixtureInput();
    const quickBooksFacts = mapQuickBooksJournalEntriesToCanonicalFacts({
      ...quickBooksInput,
      accounts: quickBooksInput.accounts.map((account) =>
        account.Id === "79"
          ? {
              ...account,
              ParentRef: {
                value: "35",
                name: "Checking"
              }
            }
          : account
      )
    });
    const quickBooksParent = accountByName(quickBooksFacts, "Checking");
    const quickBooksChild = accountByName(quickBooksFacts, "Services");

    expect(quickBooksParent.parentAccountId).toBeUndefined();
    expect(quickBooksChild.parentAccountId).toBe(quickBooksParent.accountId);
  });
});

function quickBooksFixtureInput(): QuickBooksJournalEntryAdapterInput {
  return {
    context: {
      tenantId: "tenant_adapter",
      companyId: "company_qbo",
      sourceId: "source_qbo",
      realmId: "123145999999999",
      providerEnvironment: "sandbox",
      importBatchId: "batch_qbo_1",
      checkpointId: "checkpoint_qbo_1",
      accountingBasis: "accrual",
      defaultCurrencyCode: "USD",
      importedAt: "2026-02-01T10:05:00.000Z",
      freshThrough: "2026-02-01T10:00:00.000Z",
      latestSourceUpdatedAt: "2026-02-01T10:00:00.000Z",
      runtimeConfig: {
        serviceEnvironment: "staging",
        providerMode: "sandbox",
        tenantId: "tenant_adapter"
      }
    },
    companyInfo: {
      CompanyName: "Adapter QBO Co",
      LegalName: "Adapter QuickBooks Company LLC",
      FiscalYearStartMonth: 1
    },
    accounts: [
      {
        Id: "35",
        Name: "Checking",
        AcctNum: "1000",
        AccountType: "Bank",
        AccountSubType: "Checking",
        Active: true,
        CurrencyRef: {
          value: "USD"
        }
      },
      {
        Id: "79",
        Name: "Services",
        AcctNum: "4000",
        AccountType: "Income",
        AccountSubType: "ServiceFeeIncome",
        Active: true,
        CurrencyRef: {
          value: "USD"
        }
      }
    ],
    journalEntries: [
      {
        Id: "100",
        TxnDate: "2026-01-15",
        DocNumber: "JE-100",
        PrivateNote: "Recognize services revenue",
        CurrencyRef: {
          value: "USD"
        },
        MetaData: {
          LastUpdatedTime: "2026-02-01T10:00:00.000Z"
        },
        Line: [
          {
            Id: "1",
            LineNum: 1,
            Description: "Cash received",
            Amount: "500.00",
            JournalEntryLineDetail: {
              PostingType: "Debit",
              AccountRef: {
                value: "35",
                name: "Checking"
              },
              DepartmentRef: {
                value: "ops",
                name: "Operations"
              }
            }
          },
          {
            Id: "2",
            LineNum: 2,
            Description: "Services revenue",
            Amount: "500.00",
            JournalEntryLineDetail: {
              PostingType: "Credit",
              AccountRef: {
                value: "79",
                name: "Services"
              },
              ClassRef: {
                value: "services",
                name: "Services"
              }
            }
          }
        ]
      }
    ]
  };
}

function quickBooksSdkResourcesFixtureInput(): HandrailQuickBooksSdkResourcesAdapterInput {
  const input = quickBooksFixtureInput();
  const resourceBase = {
    sourceSystem: "quickbooks" as const,
    providerEnvironment: input.context.providerEnvironment,
    realmId: input.context.realmId
  };

  return {
    context: input.context,
    resources: {
      companyInfo: {
        ...resourceBase,
        resourceType: "CompanyInfo",
        resourceId: input.context.realmId,
        resource: input.companyInfo
      },
      accounts: input.accounts.map((account) => ({
        ...resourceBase,
        resourceType: "Account" as const,
        resourceId: account.Id,
        resource: account
      })),
      journalEntries: input.journalEntries.map((journalEntry) => ({
        ...resourceBase,
        resourceType: "JournalEntry" as const,
        resourceId: journalEntry.Id,
        resource: journalEntry,
        ...(journalEntry.MetaData?.LastUpdatedTime === undefined ? {} : { sourceUpdatedAt: journalEntry.MetaData.LastUpdatedTime }),
        sourcePayloadRef: {
          sourceObjectType: "JournalEntry",
          sourceObjectId: journalEntry.Id,
          ...(journalEntry.MetaData?.LastUpdatedTime === undefined ? {} : { sourceUpdatedAt: journalEntry.MetaData.LastUpdatedTime }),
          storageRef: `quickbooks-sdk://sandbox/realm/${input.context.realmId}/JournalEntry/${journalEntry.Id}`,
          preview: {
            resourceType: "JournalEntry",
            resourceId: journalEntry.Id
          }
        },
        lineSourcePayloadRefs: Object.fromEntries(
          journalEntry.Line.map((line, index) => {
            const lineId = line.Id ?? String(line.LineNum ?? index + 1);
            const sourceObjectId = `${journalEntry.Id}:${lineId}`;
            return [
              lineId,
              {
                sourceObjectType: "JournalEntryLine",
                sourceObjectId,
                ...(journalEntry.MetaData?.LastUpdatedTime === undefined
                  ? {}
                  : { sourceUpdatedAt: journalEntry.MetaData.LastUpdatedTime }),
                storageRef: `quickbooks-sdk://sandbox/realm/${input.context.realmId}/JournalEntryLine/${sourceObjectId}`,
                preview: {
                  resourceType: "JournalEntryLine",
                  sourceObjectId
                }
              }
            ];
          })
        )
      }))
    }
  };
}

function quickBooksNormalizedLedgerTransactionsFixtureInput(): HandrailQuickBooksSdkResourcesAdapterInput {
  const input = quickBooksSdkResourcesFixtureInput();
  const context = input.context;
  const resourceBase = {
    sourceSystem: "quickbooks" as const,
    providerEnvironment: context.providerEnvironment,
    realmId: context.realmId,
    sourceUpdatedAt: "2026-02-01T10:00:00.000Z"
  };
  const sourcePayloadRef = (sourceObjectType: string, sourceObjectId: string): SafeSourcePayloadRef => ({
    sourceObjectType,
    sourceObjectId,
    sourceUpdatedAt: "2026-02-01T10:00:00.000Z",
    storageRef: `quickbooks-sdk://sandbox/realm/${context.realmId}/${sourceObjectType}/${sourceObjectId}`,
    preview: {
      sourceObjectType,
      sourceObjectId
    }
  });
  const ledgerTransaction = (
    resourceId: string,
    sourceTransactionType: string,
    transactionNumber: string,
    memo: string,
    postings: readonly {
      readonly sourcePostingId: string;
      readonly sourceLineId: string;
      readonly lineNumber: number;
      readonly description: string;
      readonly accountId: string;
      readonly accountName: string;
      readonly debitAmount?: string;
      readonly creditAmount?: string;
    }[]
  ): NormalizedQuickBooksLedgerTransactionResource => ({
    ...resourceBase,
    resourceType: "LedgerTransaction",
    resourceId,
    sourcePayloadRef: sourcePayloadRef(sourceTransactionType, resourceId),
    resource: {
      sourceTransactionId: resourceId,
      sourceTransactionType,
      transactionDate: "2026-01-15",
      transactionNumber,
      sourceUpdatedAt: "2026-02-01T10:00:00.000Z",
      currencyCode: "USD",
      memo,
      sourcePayloadRef: sourcePayloadRef(sourceTransactionType, resourceId),
      lines: postings.map((posting) => ({
        sourceLineId: posting.sourceLineId,
        lineNumber: posting.lineNumber,
        description: posting.description,
        amount: posting.debitAmount ?? `-${posting.creditAmount ?? "0.00"}`,
        accountRef: {
          sourceObjectId: posting.accountId,
          displayName: posting.accountName
        },
        sourcePayloadRef: sourcePayloadRef(`${sourceTransactionType}Line`, posting.sourcePostingId),
        postings: [
          {
            sourcePostingId: posting.sourcePostingId,
            accountRef: {
              sourceObjectId: posting.accountId,
              displayName: posting.accountName
            },
            postingDate: "2026-01-15",
            accountingBasis: "accrual",
            ...(posting.debitAmount === undefined ? {} : { debitAmount: posting.debitAmount }),
            ...(posting.creditAmount === undefined ? {} : { creditAmount: posting.creditAmount }),
            currencyCode: "USD",
            sourcePayloadRef: sourcePayloadRef(`${sourceTransactionType}Line`, posting.sourcePostingId)
          }
        ]
      }))
    }
  });

  return {
    context,
    resources: {
      ...input.resources,
      accounts: [
        ...input.resources.accounts,
        {
          sourceSystem: "quickbooks",
          providerEnvironment: context.providerEnvironment,
          realmId: context.realmId,
          resourceType: "Account",
          resourceId: "62",
          resource: {
            Id: "62",
            Name: "Accounts Receivable",
            AcctNum: "1200",
            AccountType: "Accounts Receivable",
            AccountSubType: "AccountsReceivable",
            Active: true,
            CurrencyRef: {
              value: "USD"
            }
          }
        }
      ],
      journalEntries: [],
      ledgerTransactions: [
        ledgerTransaction("100", "JournalEntry", "JE-100", "Recognize services revenue", [
          {
            sourcePostingId: "100:1",
            sourceLineId: "1",
            lineNumber: 1,
            description: "Cash received",
            accountId: "35",
            accountName: "Checking",
            debitAmount: "500.00"
          },
          {
            sourcePostingId: "100:2",
            sourceLineId: "2",
            lineNumber: 2,
            description: "Services revenue",
            accountId: "79",
            accountName: "Services",
            creditAmount: "500.00"
          }
        ]),
        ledgerTransaction("200", "Invoice", "INV-200", "Customer invoice", [
          {
            sourcePostingId: "200:ar",
            sourceLineId: "ar",
            lineNumber: 1,
            description: "Accounts receivable",
            accountId: "62",
            accountName: "Accounts Receivable",
            debitAmount: "700.00"
          },
          {
            sourcePostingId: "200:income",
            sourceLineId: "income",
            lineNumber: 2,
            description: "Services revenue",
            accountId: "79",
            accountName: "Services",
            creditAmount: "700.00"
          }
        ])
      ]
    }
  };
}

function nativeFixtureInput(): NativeLedgerAdapterInput {
  const context: SourceAdapterContext = {
    tenantId: "tenant_adapter",
    companyId: "company_native",
    sourceId: "source_native",
    sourceSystem: "native_erp",
    providerEnvironment: "native",
    sourceCompanyRef: "native-company-1",
    connectionRef: "native-ledger:native-company-1",
    importBatchId: "batch_native_1",
    checkpointId: "checkpoint_native_1",
    accountingBasis: "accrual",
    defaultCurrencyCode: "USD",
    importedAt: "2026-02-01T10:05:00.000Z",
    freshThrough: "2026-02-01T10:00:00.000Z",
    latestSourceUpdatedAt: "2026-02-01T10:00:00.000Z"
  };

  return {
    context,
    company: {
      legalName: "Adapter Native Company LLC",
      displayName: "Adapter Native Co",
      fiscalYearStartMonth: 1
    },
    accounts: [
      {
        sourceAccountId: "cash",
        accountNumber: "1000",
        name: "Checking",
        classification: "asset",
        type: "asset",
        subtype: "Bank",
        currencyCode: "USD"
      },
      {
        sourceAccountId: "services",
        accountNumber: "4000",
        name: "Services",
        classification: "income",
        type: "income",
        subtype: "ServiceRevenue",
        currencyCode: "USD"
      }
    ],
    transactions: [
      {
        sourceTransactionId: "native-je-100",
        sourceTransactionType: "JournalEntry",
        transactionDate: "2026-01-15",
        transactionNumber: "NJE-100",
        updatedAt: "2026-02-01T10:00:00.000Z",
        currencyCode: "USD",
        memo: "Recognize services revenue",
        lines: [
          {
            sourceLineId: "1",
            lineNumber: 1,
            accountSourceId: "cash",
            amount: "500.00",
            description: "Cash received"
          },
          {
            sourceLineId: "2",
            lineNumber: 2,
            accountSourceId: "services",
            amount: "-500.00",
            description: "Services revenue"
          }
        ]
      }
    ]
  };
}

function qboJournalLine(
  id: string,
  lineNumber: number,
  description: string,
  amount: string,
  postingType: "Debit" | "Credit",
  accountId: string,
  accountName: string
) {
  return {
    Id: id,
    LineNum: lineNumber,
    Description: description,
    Amount: amount,
    JournalEntryLineDetail: {
      PostingType: postingType,
      AccountRef: {
        value: accountId,
        name: accountName
      }
    }
  };
}

function reportInput(facts: CanonicalAccountingFactSet): ReportBuilderInput {
  return {
    tenantId: facts.company.tenantId,
    companyId: facts.company.companyId,
    sourceId: facts.source.sourceId,
    accounts: facts.accounts,
    postings: facts.postings,
    accountingBasis: "accrual",
    currencyCode: "USD",
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

function totalAmount(report: ReturnType<typeof buildProfitAndLossReport>, totalKey: string): string {
  const total = report.totals.find((entry) => entry.totalKey === totalKey);
  expect(total).toBeDefined();
  return total?.amount ?? "";
}

function postingByAccountName(facts: CanonicalAccountingFactSet, accountName: string) {
  const account = facts.accounts.find((entry) => entry.name === accountName);
  expect(account).toBeDefined();
  const posting = facts.postings.find((entry) => entry.accountId === account?.accountId);
  expect(posting).toBeDefined();
  if (posting === undefined) {
    throw new Error(`Missing posting for account ${accountName}`);
  }
  return posting;
}

function accountByName(facts: CanonicalAccountingFactSet, accountName: string) {
  const account = facts.accounts.find((entry) => entry.name === accountName);
  expect(account).toBeDefined();
  if (account === undefined) {
    throw new Error(`Missing account ${accountName}`);
  }
  return account;
}
