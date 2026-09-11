import { describe, expect, it } from "vitest";

import {
  adaptHandrailQuickBooksSdkFullSyncEnvelope,
  adaptHandrailQuickBooksSdkIncrementalSyncEnvelope,
  assertNoCredentialKeys,
  mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts,
  mapNormalizedQuickBooksIncrementalSyncResponseToCanonicalFacts,
  persistQuickBooksSubledgerResources,
  QuickBooksSubledgerProjectionError
} from "../src/index.js";
import type {
  HandrailQuickBooksSdkAdaptedFullSyncEnvelope,
  HandrailQuickBooksSdkAdaptedIncrementalSyncEnvelope,
  HandrailQuickBooksSdkFullSyncEnvelope,
  HandrailQuickBooksSdkIncrementalSyncEnvelope,
  HandrailQuickBooksSdkNormalizedResourceMap
} from "../src/index.js";

describe("QuickBooks SDK envelope adapter", () => {
  it("carries document tax and provider precision into the normalized commercial contract", () => {
    const envelope = fullSyncEnvelope();
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope({ ...envelope, normalizedResources: {
      ...envelope.normalizedResources,
      transactions: (envelope.normalizedResources?.transactions ?? []).map(value => ({ ...fixtureResource(value), totalTax: 27, taxCalculation: "TaxExcluded" })),
      transaction_lines: (envelope.normalizedResources?.transaction_lines ?? []).map(value => ({ ...fixtureResource(value), quantity: 0.3333333, unitAmount: 215999.9568 }))
    } }, adapterOptions());
    expect(adapted.resources.operationalDocuments?.[0]?.resource).toMatchObject({ totalTax: "27.00", taxCalculation: "TaxExcluded", lines: [{ sourceQuantity: "0.3333333", sourceUnitAmount: "215999.9568" }] });
  });

  it("adapts a full-sync envelope without losing identity, warnings, completeness, checkpoints, or posting polarity", () => {
    const sdkEnvelope = fullSyncEnvelope();
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(sdkEnvelope, adapterOptions());

    expect(adapted.sourceIdentity).toEqual({
      tenantId: "tenant_spartan",
      sourceId: "source_spartan_qbo",
      sourceSystem: "quickbooks",
      providerEnvironment: "sandbox",
      realmId: "realm_spartan",
      sourceCompanyRef: "realm_spartan"
    });
    expect(adapted.checkpoint).toMatchObject({
      checkpointId: "checkpoint_full_spartan",
      cursorKind: "full_scan",
      cursorValue: "2026-08-13T12:45:00.000Z",
      latestSourceUpdatedAt: "2026-08-13T12:45:00.000Z",
      status: "current"
    });
    expect(adapted.normalizedCompleteness).toEqual(sdkEnvelope.normalizedCompleteness);
    expect(adapted.normalizationWarnings).toEqual(sdkEnvelope.normalizationWarnings);
    expect(adapted.deltaCounts).toEqual(sdkEnvelope.deltaCounts);
    expect(adapted.warningSummary?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "quickbooks_posting_fallback",
          resourceId: "payment_700",
          severity: "warning"
        }),
        expect.objectContaining({
          code: "quickbooks_normalized_ledger_entries_incomplete",
          resourceType: "ledger_entries",
          severity: "warning"
        })
      ])
    );

    const ledgerTransaction = adapted.resources.ledgerTransactions?.[0];
    expect(ledgerTransaction?.syncAction).toBeUndefined();
    expect(ledgerTransaction?.resource.lines[0]?.postings[0]).toMatchObject({
      debitAmount: "1250.00",
      accountRef: { sourceObjectId: "100" }
    });
    expect(ledgerTransaction?.resource.lines[1]?.postings[0]).toMatchObject({
      creditAmount: "1250.00",
      accountRef: { sourceObjectId: "400" }
    });
    expect(ledgerTransaction?.resource).toMatchObject({
      totalAmount: "1250.00",
      unappliedAmount: "250.00",
      partyRef: { sourceObjectId: "customer_20", partyType: "customer" }
    });
    expect(ledgerTransaction?.resource.lines[0]?.linkedTransactions).toEqual([
      { sourceTransactionId: "invoice_600", sourceTransactionType: "Invoice" }
    ]);
    expect(ledgerTransaction?.resource.lines[0]).toMatchObject({
      sourceAmount: "1250.00",
      sourceQuantity: "5.00",
      sourceUnitAmount: "250.00",
      taxCode: "NON"
    });

    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    expect(mapped.facts.postings.map((posting) => [posting.debitAmount, posting.creditAmount])).toEqual([
      ["1250.00", "0.00"],
      ["0.00", "1250.00"]
    ]);
    expect(mapped.facts.importBatch.status).toBe("completed_with_warnings");
    expect(mapped.facts.checkpoint.checkpointId).toBe("checkpoint_full_spartan");
    expect(() => {
      assertNoCredentialKeys(adapted);
    }).not.toThrow();
  });

  it("adapts incremental resources with changed actions and resumable checkpoint evidence", () => {
    const sdkEnvelope = incrementalSyncEnvelope();
    const adapted = adaptHandrailQuickBooksSdkIncrementalSyncEnvelope(sdkEnvelope, adapterOptions());

    expect(adapted.syncMode).toBe("incremental");
    expect(adapted.cursorKind).toBe("updated_since");
    expect(adapted.cursorValue).toBe("2026-08-13T13:00:00.000Z");
    expect(adapted.resources.accounts?.every((resource) => resource.syncAction === "changed")).toBe(true);
    expect(adapted.resources.ledgerTransactions?.every((resource) => resource.syncAction === "changed")).toBe(true);

    const mapped = mapNormalizedQuickBooksIncrementalSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD",
      resumeFromCheckpointId: "checkpoint_full_spartan"
    });
    expect(mapped.resumeFromCheckpointId).toBe("checkpoint_full_spartan");
    expect(mapped.changedResourceActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: "Account", resourceId: "100", action: "changed" }),
        expect.objectContaining({ resourceType: "LedgerTransaction", resourceId: "payment_700", action: "changed" })
      ])
    );
    expect(mapped.facts.checkpoint).toMatchObject({
      checkpointId: "checkpoint_incremental_spartan",
      cursorKind: "updated_since",
      cursorValue: "2026-08-13T13:00:00.000Z"
    });
  });

  it.each(["full", "incremental"] as const)(
    "maps arbitrary Class identities into provider-neutral reporting dimensions for %s sync",
    (mode) => {
      const base = mode === "full" ? fullSyncEnvelope() : incrementalSyncEnvelope();
      const classId = "class:arbitrary/reporting-42";
      const parentId = "class:arbitrary/parent-7";
      const template = fixtureResource(base.normalizedResources?.accounts?.[0]);
      const response = {
        ...base,
        normalizedResources: {
          ...base.normalizedResources,
          classes: [{
            ...template,
            id: `accounting_class_${classId}`,
            sourceObject: "Class",
            sourceObjectId: classId,
            name: "Service Line",
            displayName: "Professional Services:Service Line",
            parentRef: { value: parentId, name: "Professional Services" },
          }],
        },
      };
      const adapted = mode === "full"
        ? adaptHandrailQuickBooksSdkFullSyncEnvelope(response as HandrailQuickBooksSdkFullSyncEnvelope, adapterOptions())
        : adaptHandrailQuickBooksSdkIncrementalSyncEnvelope(response as HandrailQuickBooksSdkIncrementalSyncEnvelope, adapterOptions());
      const mapped = mode === "full"
        ? mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted as HandrailQuickBooksSdkAdaptedFullSyncEnvelope, {
            companyId: "company_spartan", accountingBasis: "accrual", currencyCode: "USD",
          })
        : mapNormalizedQuickBooksIncrementalSyncResponseToCanonicalFacts(adapted as HandrailQuickBooksSdkAdaptedIncrementalSyncEnvelope, {
            companyId: "company_spartan", accountingBasis: "accrual", currencyCode: "USD",
            resumeFromCheckpointId: "checkpoint_full_spartan",
          });

      expect(adapted.resources.classes?.[0]?.resource.parentDimensionRef).toEqual({
        sourceObjectId: parentId,
        displayName: "Professional Services",
        dimensionKind: "class",
      });
      expect(mapped.facts.dimensions).toEqual([expect.objectContaining({
        dimensionKind: "class",
        sourceDimensionId: classId,
        name: "Service Line",
        active: true,
      })]);
      expect(mapped.facts.dimensions[0]?.parentDimensionId).toMatch(/^dimension_[a-f0-9]+$/);
    },
  );

  it("fails closed when a Class reporting dimension has no provider name", () => {
    const base = fullSyncEnvelope();
    const template = fixtureResource(base.normalizedResources?.accounts?.[0]);
    expect(() => adaptHandrailQuickBooksSdkFullSyncEnvelope({
      ...base,
      normalizedResources: {
        ...base.normalizedResources,
        classes: [{
          ...template,
          id: "accounting_class_missing_name",
          sourceObject: "Class",
          sourceObjectId: "class:arbitrary/missing-name",
          name: "",
        }],
      },
    }, adapterOptions())).toThrow(/QuickBooks class class:arbitrary\/missing-name is missing name/);
  });

  it("honors an explicit normalized void action without creating an active payment", async () => {
    const envelope = fullSyncEnvelope();
    const resources = envelope.normalizedResources;
    const stagedEnvelope = {
      ...envelope,
      normalizedResources: {
        ...resources,
        transactions: (resources?.transactions ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "BillPayment",
          transactionType: "bill_payment",
          amount: 0,
          syncAction: "voided"
        })),
        transaction_lines: (resources?.transaction_lines ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "BillPayment",
          transactionType: "bill_payment"
        })),
        ledger_entries: []
      }
    };
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(stagedEnvelope, adapterOptions());
    expect(adapted.resources.operationalDocuments?.[0]).toMatchObject({
      syncAction: "voided",
      resource: {
        sourceTransactionType: "BillPayment",
        totalAmount: "0.00"
      }
    });
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const result = await persistQuickBooksSubledgerResources({
      client: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
      companyId: "company_spartan",
      importedAt: "2026-08-13T12:46:00.000Z",
      facts: mapped.facts,
      resources: adapted.resources
    });
    expect(result.documents).toBe(0);
    expect(result.applications).toBe(0);
  });

  it("keeps a balanced zero-net journal while omitting its zero-value subledger document", async () => {
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(fullSyncEnvelope(), adapterOptions());
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const resourceTemplate = adapted.resources.operationalDocuments?.[0];
    const transactionTemplate = mapped.facts.transactions[0];
    if (resourceTemplate === undefined || transactionTemplate === undefined) {
      throw new Error("QuickBooks zero-net journal fixture requires a resource and transaction template.");
    }
    const sourceTransactionId = "invoice:balanced-zero-net/arbitrary-1048";
    const result = await persistQuickBooksSubledgerResources({
      client: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
      companyId: "company_spartan",
      importedAt: "2026-08-26T00:10:22.000Z",
      facts: {
        ...mapped.facts,
        transactions: [{
          ...transactionTemplate,
          transactionId: "transaction_zero_net_invoice",
          sourceTransactionId,
          sourceTransactionType: "Invoice"
        }]
      },
      resources: {
        ...adapted.resources,
        operationalDocuments: [{
          ...resourceTemplate,
          resourceId: sourceTransactionId,
          resource: {
            ...resourceTemplate.resource,
            sourceTransactionId,
            sourceTransactionType: "Invoice",
            totalAmount: "0.00",
            openAmount: "0.00",
            unappliedAmount: "0.00",
            lines: []
          }
        }]
      }
    });

    expect(result).toMatchObject({
      documents: 0,
      documentLines: 0,
      skippedTransactions: 1
    });
  });

  it("reports every invalid document projection in one fail-closed preflight", async () => {
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(fullSyncEnvelope(), adapterOptions());
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const resourceTemplate = adapted.resources.operationalDocuments?.[0];
    if (resourceTemplate === undefined) {
      throw new Error("QuickBooks projection preflight fixture requires a resource template.");
    }
    const invalidDocument = (
      sourceTransactionType: "Bill" | "Invoice",
      sourceTransactionId: string
    ) => ({
      ...resourceTemplate,
      resourceId: sourceTransactionId,
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId,
        sourceTransactionType,
        totalAmount: "0.00",
        openAmount: "0.00",
        unappliedAmount: "0.00",
        lines: []
      }
    });
    const statements: string[] = [];

    try {
      await persistQuickBooksSubledgerResources({
        client: {
          query: (sql) => {
            statements.push(sql);
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
        },
        companyId: "company_spartan",
        importedAt: "2026-08-26T00:10:22.000Z",
        facts: { ...mapped.facts, transactions: [], postings: [] },
        resources: {
          ...adapted.resources,
          operationalDocuments: [
            invalidDocument("Invoice", "invoice:arbitrary-1048"),
            invalidDocument("Bill", "bill:arbitrary-2048")
          ]
        }
      });
      throw new Error("Expected projection preflight to fail.");
    } catch (error: unknown) {
      if (!(error instanceof QuickBooksSubledgerProjectionError)) throw error;
      expect(error.code).toBe("quickbooks_subledger_projection_invalid");
      expect(error.diagnosticCount).toBe(2);
      expect(error.diagnosticsTruncated).toBe(false);
      expect(error.diagnostics).toEqual([
        expect.objectContaining({
          sourceTransactionType: "Invoice",
          sourceTransactionId: "invoice:arbitrary-1048",
          rejectionReasons: ["missing_balanced_journal", "non_positive_total"]
        }),
        expect.objectContaining({
          sourceTransactionType: "Bill",
          sourceTransactionId: "bill:arbitrary-2048",
          rejectionReasons: ["missing_balanced_journal", "non_positive_total"]
        })
      ]);
    }

    expect(statements).toHaveLength(4);
    expect(statements.every((statement) => /^select\b/i.test(statement.trim()))).toBe(true);
  });

  it("projects a zero-cash BillPayment with complete bill and vendor-credit evidence as a direct application", async () => {
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(fullSyncEnvelope(), adapterOptions());
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const resourceTemplate = adapted.resources.operationalDocuments?.[0];
    const transactionTemplate = mapped.facts.transactions[0];
    if (resourceTemplate === undefined || transactionTemplate === undefined) {
      throw new Error("QuickBooks application-only projection fixture requires a document and transaction template.");
    }
    const partyTemplate = mapped.facts.parties[0];
    if (partyTemplate === undefined) {
      throw new Error("QuickBooks application-only projection fixture requires a canonical party template.");
    }
    const vendorParty = {
      ...partyTemplate,
      partyId: "party_vendor_arbitrary_73",
      sourcePartyId: "vendor_arbitrary_73",
      partyType: "vendor" as const,
      displayName: "Vendor fixture"
    };
    const vendorPartyRef = {
      sourceObjectId: vendorParty.sourcePartyId,
      partyType: "vendor" as const
    };
    const bill = {
      ...resourceTemplate,
      resourceId: "bill_1822",
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId: "bill_1822",
        sourceTransactionType: "Bill",
        partyRef: vendorPartyRef,
        totalAmount: "125.00",
        openAmount: "0.00",
        unappliedAmount: "0.00",
        lines: commercialFixtureLines("125.00")
      }
    };
    const vendorCredit = {
      ...resourceTemplate,
      resourceId: "vendor_credit_1822",
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId: "vendor_credit_1822",
        sourceTransactionType: "VendorCredit",
        partyRef: vendorPartyRef,
        totalAmount: "125.00",
        openAmount: "0.00",
        unappliedAmount: "0.00",
        lines: commercialFixtureLines("125.00")
      }
    };
    const applicationOnlyBillPayment = {
      ...resourceTemplate,
      resourceId: "1822",
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId: "1822",
        sourceTransactionType: "BillPayment",
        partyRef: vendorPartyRef,
        totalAmount: "0.00",
        openAmount: "0.00",
        unappliedAmount: "0.00",
        lines: [
          {
            ...resourceTemplate.resource.lines[0],
            sourceLineId: "credit-line",
            lineNumber: 1,
            sourceAmount: "125.00",
            linkedTransactions: [{
              sourceTransactionId: "vendor_credit_1822",
              sourceTransactionType: "VendorCredit"
            }],
            postings: []
          },
          {
            ...resourceTemplate.resource.lines[0],
            sourceLineId: "bill-line",
            lineNumber: 2,
            sourceAmount: "125.00",
            linkedTransactions: [{ sourceTransactionId: "bill_1822", sourceTransactionType: "Bill" }],
            postings: []
          }
        ]
      }
    };
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const result = await persistQuickBooksSubledgerResources({
      client: {
        query(sql, params = []) {
          calls.push({ sql, params });
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
      },
      companyId: "company_spartan",
      importedAt: "2026-08-13T12:46:00.000Z",
      facts: {
        ...mapped.facts,
        parties: [...mapped.facts.parties, vendorParty],
        transactions: [
          {
            ...transactionTemplate,
            transactionId: "transaction_bill_1822",
            sourceTransactionId: "bill_1822",
            sourceTransactionType: "Bill",
            partyId: vendorParty.partyId
          },
          {
            ...transactionTemplate,
            transactionId: "transaction_vendor_credit_1822",
            sourceTransactionId: "vendor_credit_1822",
            sourceTransactionType: "VendorCredit",
            partyId: vendorParty.partyId
          }
        ]
      },
      resources: {
        ...adapted.resources,
        operationalDocuments: [bill, vendorCredit, applicationOnlyBillPayment]
      }
    });

    expect(result.documents).toBe(2);
    expect(result.applications).toBe(1);
    const applicationInsert = calls.find((call) =>
      call.params[4] === "vendor_credit_to_bill" &&
      call.sql.includes('insert into "erp_financials"."subledger_applications"')
    );
    expect(applicationInsert?.params.slice(5, 10)).toEqual([
      expect.stringMatching(/^qbo_document_/),
      expect.stringMatching(/^qbo_document_/),
      "125.00",
      "USD",
      "2026-08-13"
    ]);
  });

  it("skips a zero-cash BillPayment that exactly offsets a Deposit with VendorCredits", async () => {
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(fullSyncEnvelope(), adapterOptions());
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const resourceTemplate = adapted.resources.operationalDocuments?.[0];
    const transactionTemplate = mapped.facts.transactions[0];
    if (resourceTemplate === undefined || transactionTemplate === undefined) {
      throw new Error("QuickBooks provider-offset fixture requires a document and transaction template.");
    }
    const linkedDocument = (
      sourceTransactionId: string,
      sourceTransactionType: "Deposit" | "VendorCredit",
      totalAmount: string
    ) => ({
      ...resourceTemplate,
      resourceId: sourceTransactionId,
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId,
        sourceTransactionType,
        totalAmount,
        openAmount: "0.00",
        unappliedAmount: "0.00",
        lines: commercialFixtureLines(totalAmount)
      }
    });
    const deposit = linkedDocument("deposit_2704", "Deposit", "1948.06");
    const firstCredit = linkedDocument("vendor_credit_1", "VendorCredit", "1000.00");
    const secondCredit = linkedDocument("vendor_credit_2", "VendorCredit", "948.06");
    const providerOffset = {
      ...resourceTemplate,
      resourceId: "2704",
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId: "2704",
        sourceTransactionType: "BillPayment",
        totalAmount: "0.00",
        openAmount: "0.00",
        unappliedAmount: "0.00",
        lines: [
          {
            ...resourceTemplate.resource.lines[0],
            sourceLineId: "deposit-line",
            lineNumber: 1,
            sourceAmount: "1948.06",
            linkedTransactions: [{
              sourceTransactionId: "deposit_2704",
              sourceTransactionType: "Deposit"
            }],
            postings: []
          },
          {
            ...resourceTemplate.resource.lines[0],
            sourceLineId: "credit-line-1",
            lineNumber: 2,
            sourceAmount: "1000.00",
            linkedTransactions: [{
              sourceTransactionId: "vendor_credit_1",
              sourceTransactionType: "VendorCredit"
            }],
            postings: []
          },
          {
            ...resourceTemplate.resource.lines[0],
            sourceLineId: "credit-line-2",
            lineNumber: 3,
            sourceAmount: "948.06",
            linkedTransactions: [{
              sourceTransactionId: "vendor_credit_2",
              sourceTransactionType: "VendorCredit"
            }],
            postings: []
          }
        ]
      }
    };
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const result = await persistQuickBooksSubledgerResources({
      client: {
        query(sql, params = []) {
          calls.push({ sql, params });
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
      },
      companyId: "company_spartan",
      importedAt: "2026-08-25T04:41:37.000Z",
      facts: {
        ...mapped.facts,
        transactions: [
          {
            ...transactionTemplate,
            transactionId: "transaction_deposit_2704",
            sourceTransactionId: "deposit_2704",
            sourceTransactionType: "Deposit"
          },
          {
            ...transactionTemplate,
            transactionId: "transaction_vendor_credit_1",
            sourceTransactionId: "vendor_credit_1",
            sourceTransactionType: "VendorCredit"
          },
          {
            ...transactionTemplate,
            transactionId: "transaction_vendor_credit_2",
            sourceTransactionId: "vendor_credit_2",
            sourceTransactionType: "VendorCredit"
          }
        ]
      },
      resources: {
        ...adapted.resources,
        operationalDocuments: [deposit, firstCredit, secondCredit, providerOffset]
      }
    });

    expect(result.documents).toBe(3);
    expect(result.skippedTransactions).toBe(1);
    expect(result.applications).toBe(0);
    expect(calls.some((call) =>
      call.sql.includes('insert into "erp_financials"."subledger_documents"') &&
      call.params[14]?.toString().includes("BillPayment:2704")
    )).toBe(false);
  });

  it("projects Payment 1909 as two credit-memo applications without a cash document or postings", async () => {
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(fullSyncEnvelope(), adapterOptions());
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const resourceTemplate = adapted.resources.operationalDocuments?.[0];
    const transactionTemplate = mapped.facts.transactions[0];
    if (resourceTemplate === undefined || transactionTemplate === undefined) {
      throw new Error("QuickBooks customer-credit application fixture requires a document and transaction template.");
    }
    const canonicalDocument = (
      sourceTransactionId: string,
      sourceTransactionType: "Invoice" | "CreditMemo",
      totalAmount: string
    ) => ({
      ...resourceTemplate,
      resourceId: sourceTransactionId,
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId,
        sourceTransactionType,
        totalAmount,
        openAmount: "0.00",
        unappliedAmount: "0.00",
        lines: commercialFixtureLines(totalAmount)
      }
    });
    const applicationOnlyPayment = {
      ...resourceTemplate,
      resourceId: "1909",
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId: "1909",
        sourceTransactionType: "Payment",
        totalAmount: "0.00",
        openAmount: "0.00",
        unappliedAmount: "0.00",
        lines: [
          {
            ...resourceTemplate.resource.lines[0],
            sourceLineId: "credit-line",
            lineNumber: 1,
            sourceAmount: "100.00",
            linkedTransactions: [{ sourceTransactionId: "credit_73", sourceTransactionType: "CreditMemo" }],
            postings: []
          },
          {
            ...resourceTemplate.resource.lines[0],
            sourceLineId: "invoice-line-1",
            lineNumber: 2,
            sourceAmount: "60.00",
            linkedTransactions: [{ sourceTransactionId: "invoice_72", sourceTransactionType: "Invoice" }],
            postings: []
          },
          {
            ...resourceTemplate.resource.lines[0],
            sourceLineId: "invoice-line-2",
            lineNumber: 3,
            sourceAmount: "40.00",
            linkedTransactions: [{ sourceTransactionId: "invoice_75", sourceTransactionType: "Invoice" }],
            postings: []
          }
        ]
      }
    };
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];

    const applicationFacts = {
      ...mapped.facts,
      transactions: [
        {
          ...transactionTemplate,
          transactionId: "transaction_invoice_72",
          sourceTransactionId: "invoice_72",
          sourceTransactionType: "Invoice"
        },
        {
          ...transactionTemplate,
          transactionId: "transaction_invoice_75",
          sourceTransactionId: "invoice_75",
          sourceTransactionType: "Invoice"
        },
        {
          ...transactionTemplate,
          transactionId: "transaction_credit_73",
          sourceTransactionId: "credit_73",
          sourceTransactionType: "CreditMemo"
        }
      ],
      postings: []
    };
    const result = await persistQuickBooksSubledgerResources({
      client: {
        query(sql, params = []) {
          calls.push({ sql, params });
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
      },
      companyId: "company_spartan",
      importedAt: "2026-08-25T00:31:00.000Z",
      facts: applicationFacts,
      resources: {
        ...adapted.resources,
        operationalDocuments: [
          canonicalDocument("invoice_72", "Invoice", "60.00"),
          canonicalDocument("invoice_75", "Invoice", "40.00"),
          canonicalDocument("credit_73", "CreditMemo", "100.00"),
          applicationOnlyPayment
        ]
      }
    });

    expect(result).toMatchObject({ documents: 3, applications: 2, skippedApplications: 0 });
    expect(applicationFacts.transactions.some((transaction) => transaction.sourceTransactionId === "1909")).toBe(false);
    expect(applicationFacts.postings).toHaveLength(0);
    const applicationInserts = calls.filter((call) =>
      call.params[4] === "credit_to_invoice" &&
      call.sql.includes('insert into "erp_financials"."subledger_applications"')
    );
    expect(applicationInserts.map((call) => call.params.slice(5, 10))).toEqual([
      [
        expect.stringMatching(/^qbo_document_/),
        expect.stringMatching(/^qbo_document_/),
        "60.00",
        "USD",
        "2026-08-13"
      ],
      [
        expect.stringMatching(/^qbo_document_/),
        expect.stringMatching(/^qbo_document_/),
        "40.00",
        "USD",
        "2026-08-13"
      ]
    ]);
    expect(applicationInserts[0]?.params[5]).toBe(applicationInserts[1]?.params[5]);
    expect(applicationInserts[0]?.params[6]).not.toBe(applicationInserts[1]?.params[6]);
    const provenanceEvents = calls.filter((call) =>
      call.sql.includes('insert into "erp_financials"."financial_lifecycle_events"') &&
      JSON.stringify(call.params).includes("customer_credit_application")
    );
    expect(provenanceEvents).toHaveLength(2);
    expect(provenanceEvents.map((call) => call.params[11])).toEqual([
      expect.stringContaining('"sourceTransactionId":"1909"'),
      expect.stringContaining('"sourceTransactionId":"1909"')
    ]);
    expect(provenanceEvents.map((call) => call.params[11])).toEqual(expect.arrayContaining([
      expect.stringContaining('"creditMemoSourceTransactionId":"credit_73","invoiceSourceTransactionId":"invoice_72"'),
      expect.stringContaining('"creditMemoSourceTransactionId":"credit_73","invoiceSourceTransactionId":"invoice_75"')
    ]));
    expect(calls.some((call) =>
      call.sql.includes('insert into "erp_financials"."subledger_documents"') &&
      call.params[14]?.toString().includes("Payment:1909")
    )).toBe(false);
  });

  it("projects a zero-cash Deposit-to-Invoice Payment with its authoritative Payment customer", async () => {
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(fullSyncEnvelope(), adapterOptions());
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const resourceTemplate = adapted.resources.operationalDocuments?.[0];
    const transactionTemplate = mapped.facts.transactions[0];
    const lineTemplate = resourceTemplate?.resource.lines[0];
    if (resourceTemplate === undefined || transactionTemplate === undefined || lineTemplate === undefined) {
      throw new Error("Customer-deposit application fixture requires document, transaction, and line templates.");
    }
    const customerPartyId = transactionTemplate.partyId;
    if (customerPartyId === undefined) {
      throw new Error("Customer-deposit application fixture requires a canonical Payment customer.");
    }
    const document = (sourceTransactionId: string, sourceTransactionType: "Deposit" | "Invoice") => ({
      ...resourceTemplate,
      resourceId: sourceTransactionId,
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId,
        sourceTransactionType,
        ...(sourceTransactionType === "Deposit" ? { partyRef: { sourceObjectId: "unknown", partyType: "other" as const } } : {}),
        totalAmount: "1.00",
        openAmount: "0.00",
        unappliedAmount: "0.00",
        lines: commercialFixtureLines("1.00")
      }
    });
    const payment = {
      ...resourceTemplate,
      resourceId: "381",
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId: "381",
        sourceTransactionType: "Payment",
        totalAmount: "0.00",
        openAmount: "0.00",
        unappliedAmount: "0.00",
        lines: [
          {
            ...lineTemplate,
            sourceLineId: "deposit-line",
            lineNumber: 1,
            sourceAmount: "1.00",
            linkedTransactions: [{ sourceTransactionId: "deposit_380", sourceTransactionType: "Deposit" }],
            postings: []
          },
          {
            ...lineTemplate,
            sourceLineId: "invoice-line",
            lineNumber: 2,
            sourceAmount: "1.00",
            linkedTransactions: [{ sourceTransactionId: "invoice_379", sourceTransactionType: "Invoice" }],
            postings: []
          }
        ]
      }
    };
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];

    const result = await persistQuickBooksSubledgerResources({
      client: {
        query(sql, params = []) {
          calls.push({ sql, params });
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
      },
      companyId: "company_spartan",
      importedAt: "2026-08-26T01:11:43.185Z",
      facts: {
        ...mapped.facts,
        transactions: [
          { ...omitFixtureField(transactionTemplate, "partyId"), transactionId: "transaction_deposit_380", sourceTransactionId: "deposit_380", sourceTransactionType: "Deposit" },
          { ...transactionTemplate, transactionId: "transaction_invoice_379", sourceTransactionId: "invoice_379", sourceTransactionType: "Invoice" }
        ],
        postings: []
      },
      resources: {
        ...adapted.resources,
        operationalDocuments: [document("deposit_380", "Deposit"), document("invoice_379", "Invoice"), payment]
      }
    });

    expect(result).toMatchObject({ documents: 2, applications: 1, skippedApplications: 0 });
    const depositInsert = calls.find((call) =>
      call.sql.includes('insert into "erp_financials"."subledger_documents"') && call.params[4] === "deposit"
    );
    expect(depositInsert?.params.slice(11, 14)).toEqual(["1.00", "1.00", "open"]);
    expect(depositInsert?.params[6]).toBe(customerPartyId);
    const applicationInsert = calls.find((call) =>
      call.sql.includes('insert into "erp_financials"."subledger_applications"')
    );
    expect(applicationInsert?.params[4]).toBe("credit_to_invoice");
    expect(applicationInsert?.params[7]).toBe("1.00");
    const applicationEvent = calls.find((call) =>
      call.sql.includes('insert into "erp_financials"."financial_lifecycle_events"') &&
      call.params[5] === "quickbooks_customer_deposit_application_imported"
    );
    expect(applicationEvent?.params[11]).toEqual(expect.stringContaining(
      '"depositSourceTransactionId":"deposit_380","invoiceSourceTransactionId":"invoice_379"'
    ));
    expect(calls.some((call) =>
      call.sql.includes('insert into "erp_financials"."subledger_documents"') &&
      call.params[14]?.toString().includes("Payment:381")
    )).toBe(false);

    try {
      await persistQuickBooksSubledgerResources({
        client: { query: () => Promise.resolve({ rows: [], rowCount: 1 }) },
        companyId: "company_spartan",
        importedAt: "2026-08-26T01:11:43.185Z",
        facts: {
          ...mapped.facts,
          transactions: [
            { ...omitFixtureField(transactionTemplate, "partyId"), transactionId: "transaction_deposit_380", sourceTransactionId: "deposit_380", sourceTransactionType: "Deposit" },
            { ...transactionTemplate, transactionId: "transaction_invoice_379", sourceTransactionId: "invoice_379", sourceTransactionType: "Invoice", partyId: "canonical_other_customer" }
          ],
          postings: []
        },
        resources: {
          ...adapted.resources,
          operationalDocuments: [document("deposit_380", "Deposit"), document("invoice_379", "Invoice"), payment]
        }
      });
      throw new Error("Expected a mismatched Deposit-to-Invoice customer to fail closed.");
    } catch (error: unknown) {
      if (!(error instanceof QuickBooksSubledgerProjectionError)) throw error;
      expect(error.code).toBe("quickbooks_subledger_projection_invalid");
      expect(error.diagnostic.projectionKind).toBe("customer_deposit_application");
      expect(error.diagnostic.rejectionReasons).toEqual(["application_party_mismatch"]);
    }
  });

  it("fails closed for incomplete, mismatched, ambiguous, and unsupported zero-total Payment applications", async () => {
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(fullSyncEnvelope(), adapterOptions());
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const resourceTemplate = adapted.resources.operationalDocuments?.[0];
    const transactionTemplate = mapped.facts.transactions[0];
    const lineTemplate = resourceTemplate?.resource.lines[0];
    if (resourceTemplate === undefined || transactionTemplate === undefined || lineTemplate === undefined) {
      throw new Error("QuickBooks unsafe customer-credit fixtures require document, transaction, and line templates.");
    }
    const document = (sourceTransactionId: string, sourceTransactionType: "CreditMemo" | "Invoice") => ({
      ...resourceTemplate,
      resourceId: sourceTransactionId,
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId,
        sourceTransactionType,
        totalAmount: "100.00",
        openAmount: "100.00",
        unappliedAmount: "100.00",
        lines: commercialFixtureLines("100.00")
      }
    });
    const creditLine = {
      ...lineTemplate,
      sourceLineId: "credit-line",
      lineNumber: 1,
      sourceAmount: "100.00",
      linkedTransactions: [{ sourceTransactionId: "credit_73", sourceTransactionType: "CreditMemo" }],
      postings: []
    };
    const invoiceLine = {
      ...lineTemplate,
      sourceLineId: "invoice-line",
      lineNumber: 2,
      sourceAmount: "100.00",
      linkedTransactions: [{ sourceTransactionId: "invoice_72", sourceTransactionType: "Invoice" }],
      postings: []
    };
    const facts = {
      ...mapped.facts,
      transactions: [
        { ...transactionTemplate, transactionId: "transaction_invoice_72", sourceTransactionId: "invoice_72", sourceTransactionType: "Invoice" },
        { ...transactionTemplate, transactionId: "transaction_credit_73", sourceTransactionId: "credit_73", sourceTransactionType: "CreditMemo" }
      ],
      postings: []
    };
    const unsafeCases = [
      { name: "incomplete", lines: [invoiceLine], reason: "no_credit_memo_link" },
      {
        name: "mismatched",
        lines: [creditLine, { ...invoiceLine, sourceAmount: "99.00" }],
        reason: "invoice_credit_totals_mismatch"
      },
      {
        name: "ambiguous per-link amount",
        lines: [{
          ...creditLine,
          linkedTransactions: [
            { sourceTransactionId: "credit_73", sourceTransactionType: "CreditMemo" },
            { sourceTransactionId: "credit_73", sourceTransactionType: "CreditMemo" }
          ]
        }, invoiceLine],
        reason: "multi_link_amount_ambiguous"
      },
      {
        name: "unsupported",
        lines: [creditLine, {
          ...invoiceLine,
          linkedTransactions: [{ sourceTransactionId: "invoice_72", sourceTransactionType: "Bill" }]
        }],
        reason: "unsupported_linked_transaction_type"
      },
      {
        name: "missing linked document",
        lines: [{
          ...creditLine,
          linkedTransactions: [{ sourceTransactionId: "credit_missing", sourceTransactionType: "CreditMemo" }]
        }, invoiceLine],
        reason: "missing_linked_document"
      }
    ];

    for (const unsafe of unsafeCases) {
      const payment = {
        ...resourceTemplate,
        resourceId: `unsafe-${unsafe.name}`,
        resource: {
          ...resourceTemplate.resource,
          sourceTransactionId: `unsafe-${unsafe.name}`,
          sourceTransactionType: "Payment",
          totalAmount: "0.00",
          openAmount: "0.00",
          unappliedAmount: "0.00",
          memo: "",
          lines: unsafe.lines
        }
      };
      try {
        await persistQuickBooksSubledgerResources({
          client: { query: () => Promise.resolve({ rows: [], rowCount: 1 }) },
          companyId: "company_spartan",
          importedAt: "2026-08-25T00:31:00.000Z",
          facts,
          resources: {
            ...adapted.resources,
            operationalDocuments: [document("invoice_72", "Invoice"), document("credit_73", "CreditMemo"), payment]
          }
        });
        throw new Error(`Expected unsafe ${unsafe.name} projection to fail closed.`);
      } catch (error: unknown) {
        if (!(error instanceof QuickBooksSubledgerProjectionError)) throw error;
        expect(error.code).toBe("quickbooks_subledger_projection_invalid");
        expect(error.diagnostic).toMatchObject({
          projectionKind: "unclassified_zero_total"
        });
        expect(error.diagnostic.rejectionReasons).toContain(unsafe.reason);
      }
    }

    const guardedPayment = (sourceTransactionId: string, totalAmount: string) => ({
      ...resourceTemplate,
      resourceId: sourceTransactionId,
      resource: {
        ...resourceTemplate.resource,
        sourceTransactionId,
        sourceTransactionType: "Payment",
        totalAmount,
        openAmount: "0.00",
        unappliedAmount: "0.00",
        lines: [creditLine, invoiceLine]
      }
    });
    const documents = [document("invoice_72", "Invoice"), document("credit_73", "CreditMemo")];
    await expect(persistQuickBooksSubledgerResources({
      client: { query: () => Promise.resolve({ rows: [], rowCount: 1 }) },
      companyId: "company_spartan",
      importedAt: "2026-08-25T00:31:00.000Z",
      facts,
      resources: {
        ...adapted.resources,
        operationalDocuments: [...documents, guardedPayment("positive-payment", "1.00")]
      }
    })).rejects.toMatchObject({
      diagnostic: {
        missingBalancedJournal: true,
        totalAmountState: "positive",
        projectionKind: "canonical_document",
        rejectionReasons: ["missing_balanced_journal"]
      }
    });
    await expect(persistQuickBooksSubledgerResources({
      client: { query: () => Promise.resolve({ rows: [], rowCount: 1 }) },
      companyId: "company_spartan",
      importedAt: "2026-08-25T00:31:00.000Z",
      facts: {
        ...facts,
        transactions: [
          ...facts.transactions,
          {
            ...transactionTemplate,
            transactionId: "transaction_balanced_payment",
            sourceTransactionId: "balanced-payment",
            sourceTransactionType: "Payment"
          }
        ]
      },
      resources: {
        ...adapted.resources,
        operationalDocuments: [...documents, guardedPayment("balanced-payment", "0.00")]
      }
    })).rejects.toMatchObject({
      diagnostic: {
        missingBalancedJournal: false,
        totalAmountState: "zero",
        projectionKind: "canonical_document",
        rejectionReasons: ["non_positive_total"]
      }
    });
  });

  it("fails an ambiguous zero-total BillPayment with structured safe diagnostics", async () => {
    const envelope = fullSyncEnvelope();
    const resources = envelope.normalizedResources;
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope({
      ...envelope,
      normalizedResources: {
        ...resources,
        transactions: (resources?.transactions ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "BillPayment",
          transactionType: "bill_payment",
          amount: 0,
          privateNote: undefined
        })),
        transaction_lines: (resources?.transaction_lines ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "BillPayment",
          transactionType: "bill_payment"
        })),
        ledger_entries: []
      }
    }, adapterOptions());
    expect(adapted.resources.operationalDocuments?.[0]?.syncAction).toBeUndefined();
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });

    await expect(persistQuickBooksSubledgerResources({
      client: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
      companyId: "company_spartan",
      importedAt: "2026-08-13T12:46:00.000Z",
      facts: mapped.facts,
      resources: adapted.resources
    })).rejects.toMatchObject({
      code: "quickbooks_subledger_projection_invalid",
      diagnostic: {
        sourceTransactionType: "BillPayment",
        sourceTransactionId: "payment_700",
        missingBalancedJournal: true,
        totalAmountState: "zero",
        projectionKind: "unclassified_zero_total",
        rejectionReasons: [
          "no_bill_link",
          "no_vendor_credit_link",
          "unsupported_linked_transaction_type"
        ],
        lineCount: 1,
        linkedTransactionCount: 1,
        linkedTransactionTypes: [{ type: "Invoice", count: 1 }],
        nonZeroLineCount: 1,
        unlinkedNonZeroLineCount: 0,
        multiLinkedLineCount: 0,
        missingLinkedAmountCount: 0,
        billLinkedAmountTotal: "0.00",
        vendorCreditLinkedAmountTotal: "0.00",
        otherLinkedAmountTotal: "1250.00",
        missingLinkedTransactionIds: [],
        memoIndicatesVoid: false
      }
    });
  });

  it("accepts parentAccountId as a stable SDK fallback and maps it to the canonical parent id", () => {
    const envelope = fullSyncEnvelope();
    const accounts = (envelope.normalizedResources?.accounts ?? []) as readonly Record<string, unknown>[];
    const hierarchyEnvelope = {
      ...envelope,
      normalizedResources: {
        ...envelope.normalizedResources,
        accounts: accounts.map((account) => account.sourceObjectId === "400"
          ? { ...account, parentAccountId: "100", subAccount: true }
          : account)
      }
    };

    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(hierarchyEnvelope, adapterOptions());
    expect(adapted.resources.accounts.find((account) => account.resource.sourceAccountId === "400")?.resource)
      .toMatchObject({ parentAccountRef: { sourceObjectId: "100" } });

    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const parent = mapped.facts.accounts.find((account) => account.sourceAccountId === "100");
    const child = mapped.facts.accounts.find((account) => account.sourceAccountId === "400");
    expect(child?.parentAccountId).toBe(parent?.accountId);
  });

  it("rejects conflicting provider parent fields at the ERP SDK boundary", () => {
    const envelope = fullSyncEnvelope();
    const accounts = (envelope.normalizedResources?.accounts ?? []) as readonly Record<string, unknown>[];
    const malformedEnvelope = {
      ...envelope,
      normalizedResources: {
        ...envelope.normalizedResources,
        accounts: accounts.map((account) => account.sourceObjectId === "400"
          ? { ...account, parentRef: { value: "100" }, parentAccountId: "999", subAccount: true }
          : account)
      }
    };

    expect(() => adaptHandrailQuickBooksSdkFullSyncEnvelope(malformedEnvelope, adapterOptions()))
      .toThrow(/conflicting parentRef\.value and parentAccountId/);
  });

  it("persists adapted QuickBooks operational documents without inventing unresolved applications", async () => {
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(fullSyncEnvelope(), adapterOptions());
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const calls: string[] = [];
    const result = await persistQuickBooksSubledgerResources({
      client: {
        query(sql) {
          calls.push(sql);
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
      },
      companyId: "company_spartan",
      importedAt: "2026-08-13T12:46:00.000Z",
      facts: mapped.facts,
      resources: adapted.resources
    });

    expect(result).toEqual({
      documents: 1,
      documentLines: 0,
      applications: 0,
      skippedTransactions: 0,
      skippedDocumentLines: 0,
      skippedApplications: 1,
      voidedDocuments: 0,
      removedLedgerPostings: 0,
      unresolvedApplications: [expect.objectContaining({ reason: "missing_target_document" })]
    });
    expect(calls.some((sql) => sql.includes('"subledger_documents"'))).toBe(true);
    expect(calls.some((sql) => sql.includes('insert into "erp_financials"."subledger_applications"'))).toBe(false);
  });

  it("turns QuickBooks LinkedTxn evidence into a canonical payment application", async () => {
    const envelope = fullSyncEnvelope();
    const resources = envelope.normalizedResources;
    const invoiceMetadata = (id: string) => ({
      id,
      tenantId: "tenant_spartan",
      realmId: "realm_spartan",
      companyId: "realm_spartan",
      provider: "intuit" as const,
      providerEnvironment: "sandbox" as const,
      source: "quickbooks_accounting_api" as const,
      sourceObject: "Invoice",
      sourceObjectId: id,
      importBatchId: "batch_full_spartan",
      jobId: "job_full_spartan",
      importedAt: "2026-08-13T12:46:00.000Z",
      syncedAt: "2026-08-13T12:46:00.000Z",
      sourceUpdatedAt: "2026-08-13T12:45:00.000Z",
      audit: { sourcePayloadRef: `raw://batch_full_spartan/Invoice/${id}` }
    });
    const linkedEnvelope = {
      ...envelope,
      normalizedResources: {
        ...resources,
        accounts: [
          ...(resources?.accounts ?? []),
          { ...invoiceMetadata("110"), sourceObject: "Account", name: "Accounts Receivable", accountType: "Accounts Receivable", classification: "Asset", active: true }
        ],
        transactions: [
          ...(resources?.transactions ?? []),
          { ...invoiceMetadata("invoice_600"), transactionType: "invoice", transactionDate: "2026-08-01", dueDate: "2026-08-31", amount: 1250, balance: 0, party: { value: "customer_20", name: "Acme" }, documentNumber: "INV-600" }
        ],
        transaction_lines: [
          ...(resources?.transaction_lines ?? []),
          { ...invoiceMetadata("invoice_600:1"), transactionType: "invoice", transactionId: "invoice_600", lineId: "1", lineIndex: 0, lineOrder: 1, amount: 1250, quantity: 5, unitAmount: 250, account: { value: "400", name: "Service Revenue" } }
        ],
        ledger_entries: [
          ...(resources?.ledger_entries ?? []).map((value) => {
            const entry = fixtureResource(value);
            return (
              entry.sourceObject === "Payment" && entry.lineId === "1"
                ? { ...entry, lineId: "derived-ar-1" }
                : entry
            );
          }),
          { ...invoiceMetadata("invoice_600:1"), transactionId: "invoice_600", transactionType: "invoice", lineId: "1", transactionDate: "2026-08-01", postingType: "Credit", amount: 1250, account: { value: "400", name: "Service Revenue" }, party: { value: "customer_20", name: "Acme" }, currency: { value: "USD" } },
          { ...invoiceMetadata("invoice_600:ar"), transactionId: "invoice_600", transactionType: "invoice", lineId: "derived-ar-offset", transactionDate: "2026-08-01", postingType: "Debit", amount: 1250, account: { value: "110", name: "Accounts Receivable" }, party: { value: "customer_20", name: "Acme" }, currency: { value: "USD" } }
        ]
      }
    };
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(linkedEnvelope, adapterOptions());
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const calls: string[] = [];
    const result = await persistQuickBooksSubledgerResources({
      client: { query(sql) { calls.push(sql); return Promise.resolve({ rows: [], rowCount: 1 }); } },
      companyId: "company_spartan",
      importedAt: "2026-08-13T12:46:00.000Z",
      facts: mapped.facts,
      resources: adapted.resources
    });

    expect(result).toEqual({
      documents: 2,
      documentLines: 1,
      applications: 1,
      skippedTransactions: 0,
      skippedDocumentLines: 0,
      skippedApplications: 0,
      voidedDocuments: 0,
      removedLedgerPostings: 0,
      unresolvedApplications: []
    });
    expect(calls.filter((sql) => sql.includes('insert into "erp_financials"."subledger_applications"'))).toHaveLength(1);
    expect(calls.some((sql) => sql.includes('set "open_amount" = $5'))).toBe(true);
  });

  it("restores BillPayment LinkedTxn evidence from derived A/P ledger line ids", () => {
    const envelope = fullSyncEnvelope();
    const resources = envelope.normalizedResources;
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope({
      ...envelope,
      normalizedResources: {
        ...resources,
        transactions: (resources?.transactions ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "BillPayment",
          transactionType: "bill_payment"
        })),
        transaction_lines: (resources?.transaction_lines ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "BillPayment",
          transactionType: "bill_payment"
        })),
        ledger_entries: (resources?.ledger_entries ?? []).map((value) => {
          const entry = fixtureResource(value);
          return {
            ...entry,
            sourceObject: "BillPayment",
            transactionType: "bill_payment",
            lineId: entry.lineId === "1" ? "derived-ap-1" : entry.lineId
          };
        })
      }
    }, adapterOptions());

    expect(adapted.resources.ledgerTransactions?.[0]?.resource.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceLineId: "derived-ap-1",
        sourceAmount: "1250.00",
        linkedTransactions: [{ sourceTransactionId: "invoice_600", sourceTransactionType: "Invoice" }]
      })
    ]));
  });

  it("keeps raw QuickBooks bill splits and their customer allocation out of the GL projection", async () => {
    const envelope = fullSyncEnvelope();
    const resources = envelope.normalizedResources;
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope({
      ...envelope,
      normalizedResources: {
        ...resources,
        transactions: (resources?.transactions ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "Bill",
          transactionType: "bill",
          balance: 0,
          party: { value: "vendor_1", name: "TD Synnex" },
          documentNumber: "9662951"
        })),
        transaction_lines: (resources?.transaction_lines ?? []).flatMap((value) => {
          const base = {
            ...fixtureResource(value),
            sourceObject: "Bill",
            transactionType: "bill",
            detailType: "AccountBasedExpenseLineDetail",
            quantity: 1,
            account: { value: "400", name: "Microsoft Office Subscriptions" },
            party: { value: "customer_20", name: "Houchens Industries, Inc." },
            linkedTransactions: []
          };
          return [
            { ...base, amount: 400, unitAmount: 400, description: "NCE Microsoft 365 Business Standard" },
            {
              ...base,
              id: "payment_700:2",
              sourceObjectId: "payment_700:2",
              lineId: "2",
              lineIndex: 1,
              lineOrder: 2,
              amount: 850,
              unitAmount: 850,
              description: "NCE Microsoft 365 Enterprise"
            },
            {
              ...base,
              id: "payment_700:subtotal",
              sourceObjectId: "payment_700:subtotal",
              lineId: "subtotal",
              lineIndex: 2,
              lineOrder: 3,
              detailType: "SubTotalLineDetail",
              amount: 1250,
              account: undefined,
              item: undefined,
              party: undefined,
              description: "Subtotal"
            }
          ];
        }),
        ledger_entries: (resources?.ledger_entries ?? []).map((value, index) => ({
          ...fixtureResource(value),
          sourceObject: "Bill",
          transactionType: "bill",
          lineId: `provider-general-ledger-${String(index + 1)}`,
          party: { value: "vendor_1", name: "TD Synnex" }
        }))
      }
    }, adapterOptions());

    expect(adapted.resources.ledgerTransactions?.[0]?.resource.lines[0]?.postings).not.toHaveLength(0);
    expect(adapted.resources.operationalDocuments?.[0]?.resource).toMatchObject({
      transactionNumber: "9662951",
      openAmount: "0.00",
      lines: [
        {
          sourceLineId: "1",
          detailType: "AccountBasedExpenseLineDetail",
          sourceAmount: "400.00",
          description: "NCE Microsoft 365 Business Standard",
          accountRef: { sourceObjectId: "400" },
          partyRef: {
            sourceObjectId: "customer_20",
            displayName: "Houchens Industries, Inc.",
            partyType: "customer"
          },
          postings: []
        },
        {
          sourceLineId: "2",
          detailType: "AccountBasedExpenseLineDetail",
          sourceAmount: "850.00",
          description: "NCE Microsoft 365 Enterprise",
          postings: []
        },
        {
          sourceLineId: "subtotal",
          detailType: "SubTotalLineDetail",
          sourceAmount: "1250.00",
          description: "Subtotal",
          postings: []
        }
      ]
    });

    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const lineInserts: readonly unknown[][] = [];
    const result = await persistQuickBooksSubledgerResources({
      client: {
        query(sql, params = []) {
          if (sql.includes('insert into "erp_financials"."subledger_document_lines"')) {
            (lineInserts as unknown[][]).push([...params]);
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
      },
      companyId: "company_spartan",
      importedAt: "2026-08-13T12:46:00.000Z",
      facts: mapped.facts,
      resources: adapted.resources
    });

    expect(lineInserts).toHaveLength(2);
    expect(result.skippedDocumentLines).toBe(1);
    const customerPartyId = mapped.facts.parties.find((party) => party.sourcePartyId === "customer_20")?.partyId;
    expect(lineInserts.map((params) => params[8])).toEqual([customerPartyId, customerPartyId]);
    expect(lineInserts.reduce((sum, params) => sum + Number(params[16]), 0)).toBe(1250);
  });

  it("retains a settled QuickBooks deposit and its balanced GL without projecting accountless allocation lines", async () => {
    const envelope = fullSyncEnvelope();
    const resources = envelope.normalizedResources;
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope({
      ...envelope,
      normalizedResources: {
        ...resources,
        transactions: (resources?.transactions ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "Deposit",
          transactionType: "deposit",
          sourceObjectId: "102",
          id: "102",
          amount: 408,
          documentNumber: undefined,
          party: undefined
        })),
        transaction_lines: (resources?.transaction_lines ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "Deposit",
          transactionType: "deposit",
          transactionId: "102",
          sourceObjectId: "102:synthetic-line-1",
          id: "102:synthetic-line-1",
          lineId: "synthetic-line-1",
          detailType: "DepositLineDetail",
          amount: 408,
          account: undefined,
          item: undefined,
          quantity: undefined,
          unitAmount: undefined,
          linkedTransactions: [{ transactionId: "payment_700", transactionType: "Payment" }]
        })),
        ledger_entries: (resources?.ledger_entries ?? []).map((value, index) => ({
          ...fixtureResource(value),
          sourceObject: "Deposit",
          transactionType: "deposit",
          transactionId: "102",
          sourceObjectId: `102:provider-general-ledger-${String(index + 1)}`,
          id: `102:provider-general-ledger-${String(index + 1)}`,
          lineId: `provider-general-ledger-${String(index + 1)}`,
          amount: 408
        }))
      }
    }, adapterOptions());
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    const lineInserts: readonly unknown[][] = [];
    const calls: string[] = [];
    const result = await persistQuickBooksSubledgerResources({
      client: {
        query(sql, params = []) {
          calls.push(sql);
          if (sql.includes('insert into "erp_financials"."subledger_document_lines"')) {
            (lineInserts as unknown[][]).push([...params]);
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
      },
      companyId: "company_spartan",
      importedAt: "2026-08-13T12:46:00.000Z",
      facts: mapped.facts,
      resources: adapted.resources
    });

    expect(mapped.facts.postings.map((posting) => [posting.debitAmount, posting.creditAmount])).toEqual([
      ["408.00", "0.00"],
      ["0.00", "408.00"]
    ]);
    expect(result.documents).toBe(1);
    expect(result.documentLines).toBe(0);
    expect(lineInserts).toHaveLength(0);
    expect(calls.some((sql) => sql.includes('delete from "erp_financials"."subledger_document_lines"'))).toBe(true);
  });

  it("rejects incomplete commercial detail before deleting or persisting any rows", async () => {
    const envelope = fullSyncEnvelope();
    const resources = envelope.normalizedResources;
    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope({
      ...envelope,
      normalizedResources: {
        ...resources,
        transactions: (resources?.transactions ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "Bill",
          transactionType: "bill",
          party: { value: "vendor_1", name: "Vendor One" }
        })),
        transaction_lines: (resources?.transaction_lines ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "Bill",
          transactionType: "bill",
          detailType: "AccountBasedExpenseLineDetail",
          account: undefined,
          item: undefined
        })),
        ledger_entries: (resources?.ledger_entries ?? []).map((value) => ({
          ...fixtureResource(value),
          sourceObject: "Bill",
          transactionType: "bill"
        }))
      }
    }, adapterOptions());
    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });

    const lineInserts: readonly unknown[][] = [];
    const calls: string[] = [];
    await expect(persistQuickBooksSubledgerResources({
      client: {
        query(sql, params = []) {
          calls.push(sql);
          if (sql.includes('insert into "erp_financials"."subledger_document_lines"')) {
            (lineInserts as unknown[][]).push([...params]);
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
      },
      companyId: "company_spartan",
      importedAt: "2026-08-13T12:46:00.000Z",
      facts: mapped.facts,
      resources: adapted.resources
    })).rejects.toThrow("unresolved_line_account");

    expect(mapped.facts.postings).toHaveLength(2);
    expect(calls.every(sql => /^select\b/i.test(sql.trim()))).toBe(true);
    expect(lineInserts).toHaveLength(0);
  });

  it("fails closed when SDK resource identity differs from the envelope", () => {
    const sdkEnvelope = fullSyncEnvelope({ resourceTenantId: "tenant_other" });

    expect(() => adaptHandrailQuickBooksSdkFullSyncEnvelope(sdkEnvelope, adapterOptions())).toThrow(
      /resource identity does not match tenant tenant_spartan/
    );
  });

  it("requires explicit Debit or Credit polarity for every ledger posting", () => {
    const sdkEnvelope = fullSyncEnvelope({ postingType: "Unknown" });

    expect(() => adaptHandrailQuickBooksSdkFullSyncEnvelope(sdkEnvelope, adapterOptions())).toThrow(
      /invalid postingType Unknown; expected Debit or Credit/
    );
  });

  it("preserves negative posting polarity and omits zero-value ledger rows", () => {
    const sdkEnvelope = fullSyncEnvelope({ firstAmount: 0, secondAmount: -1250 });

    const adapted = adaptHandrailQuickBooksSdkFullSyncEnvelope(sdkEnvelope, adapterOptions());
    const lines = adapted.resources.ledgerTransactions?.[0]?.resource.lines;

    expect(lines).toHaveLength(1);
    expect(lines?.[0]?.postings).toEqual([
      expect.objectContaining({
        debitAmount: "1250.00",
        accountRef: { sourceObjectId: "400", displayName: "Service Revenue" }
      })
    ]);

    const mapped = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(adapted, {
      companyId: "company_spartan",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });
    expect(mapped.facts.postings.map((posting) => [posting.debitAmount, posting.creditAmount])).toEqual([
      ["1250.00", "0.00"]
    ]);
  });
});

function adapterOptions() {
  return {
    sourceId: "source_spartan_qbo",
    accountingBasis: "accrual" as const,
    currencyCode: "USD",
    companyDisplayName: "Spartan Cyber"
  };
}

function fixtureResource(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("QuickBooks fixture resource must be an object");
  }
  return value as Record<string, unknown>;
}

function fullSyncEnvelope(
  overrides: {
    readonly resourceTenantId?: string;
    readonly postingType?: string;
    readonly firstAmount?: number;
    readonly secondAmount?: number;
  } = {}
): HandrailQuickBooksSdkFullSyncEnvelope {
  return {
    contractId: "handrail.quickbooks.normalized-sync-envelope.v1",
    syncMode: "full",
    tenantId: "tenant_spartan",
    companyId: "realm_spartan",
    importBatchId: "batch_full_spartan",
    jobId: "job_full_spartan",
    status: "succeeded",
    normalizedResourceCounts: { accounts: 2, ledger_entries: 2 },
    normalizedResources: normalizedResources(overrides),
    normalizedCompleteness: {
      accounts: {
        resourceFamily: "accounts",
        complete: true,
        status: "complete",
        normalizedRecordCount: 2,
        reason: "All account pages completed."
      },
      ledger_entries: {
        resourceFamily: "ledger_entries",
        complete: false,
        status: "incomplete",
        normalizedRecordCount: 2,
        reason: "One tax detail row could not be assigned to an account."
      }
    },
    normalizationWarnings: [
      {
        code: "quickbooks_posting_fallback",
        objectType: "Payment",
        transactionId: "payment_700",
        message: "A bounded posting fallback was used."
      }
    ],
    deltaCounts: {
      skippedCount: 0,
      changedCount: 2,
      insertedCount: 2,
      failedCount: 0,
      unchangedCount: 0,
      updatedCount: 0
    },
    audit: {
      checkpointId: "checkpoint_full_spartan",
      importBatchId: "batch_full_spartan",
      jobId: "job_full_spartan",
      realmId: "realm_spartan",
      sourcePayloadRef: "raw://batch_full_spartan"
    },
    importVolume: { entityCounts: { accounts: 2, ledger_entries: 2 } },
    importBatch: {
      startedAt: "2026-08-13T12:40:00.000Z",
      completedAt: "2026-08-13T12:46:00.000Z",
      realmId: "realm_spartan",
      status: "succeeded"
    },
    checkpoint: {
      checkpointId: "checkpoint_full_spartan",
      checkpointRef: "checkpoint://quickbooks/tenant_spartan/checkpoint_full_spartan",
      completedAt: "2026-08-13T12:46:00.000Z",
      entity: "ledger_entries",
      providerUpdatedAtWatermark: "2026-08-13T12:45:00.000Z",
      startedAt: "2026-08-13T12:40:00.000Z",
      status: "succeeded"
    },
    syncJob: {
      startedAt: "2026-08-13T12:40:00.000Z",
      completedAt: "2026-08-13T12:46:00.000Z",
      audit: { sourcePayloadRef: "raw://batch_full_spartan/sync-jobs/job_full_spartan" }
    }
  };
}

function incrementalSyncEnvelope(): HandrailQuickBooksSdkIncrementalSyncEnvelope {
  const full = fullSyncEnvelope();
  const checkpoint = full.checkpoint;
  if (checkpoint === undefined) {
    throw new Error("Full-sync fixture checkpoint is required.");
  }
  return {
    ...full,
    syncMode: "incremental",
    importBatchId: "batch_incremental_spartan",
    jobId: "job_incremental_spartan",
    normalizedResources: normalizedResources({
      importBatchId: "batch_incremental_spartan",
      jobId: "job_incremental_spartan"
    }),
    audit: {
      ...full.audit,
      checkpointId: "checkpoint_incremental_spartan",
      importBatchId: "batch_incremental_spartan",
      jobId: "job_incremental_spartan"
    },
    importBatch: {
      ...full.importBatch,
      startedAt: "2026-08-13T13:00:00.000Z",
      completedAt: "2026-08-13T13:01:00.000Z"
    },
    checkpoint: {
      ...checkpoint,
      checkpointId: "checkpoint_incremental_spartan",
      checkpointRef: "checkpoint://quickbooks/tenant_spartan/checkpoint_incremental_spartan",
      completedAt: "2026-08-13T13:01:00.000Z",
      providerUpdatedAtWatermark: "2026-08-13T13:00:00.000Z"
    },
    syncJob: {
      ...full.syncJob,
      startedAt: "2026-08-13T13:00:00.000Z",
      completedAt: "2026-08-13T13:01:00.000Z"
    }
  };
}

function normalizedResources(overrides: {
  readonly importBatchId?: string;
  readonly jobId?: string;
  readonly resourceTenantId?: string;
  readonly postingType?: string;
  readonly firstAmount?: number;
  readonly secondAmount?: number;
}): HandrailQuickBooksSdkNormalizedResourceMap {
  const importBatchId = overrides.importBatchId ?? "batch_full_spartan";
  const jobId = overrides.jobId ?? "job_full_spartan";
  const metadata = (input: { readonly id: string; readonly sourceObject: string }) => ({
    id: input.id,
    sourceObject: input.sourceObject,
    sourceObjectId: input.id,
    tenantId: overrides.resourceTenantId ?? "tenant_spartan",
    realmId: "realm_spartan",
    companyId: "realm_spartan",
    provider: "intuit",
    providerEnvironment: "sandbox",
    source: "quickbooks_accounting_api",
    importBatchId,
    jobId,
    importedAt: "2026-08-13T12:46:00.000Z",
    syncedAt: "2026-08-13T12:46:00.000Z",
    sourceUpdatedAt: "2026-08-13T12:45:00.000Z",
    audit: {
      checkpointId: "checkpoint_full_spartan",
      sourcePayloadRef: `raw://${importBatchId}/${input.sourceObject}/${input.id}`
    }
  });

  return {
    accounts: [
      {
        ...metadata({ id: "100", sourceObject: "Account" }),
        name: "Operating Cash",
        accountType: "Bank",
        classification: "Asset",
        active: true,
        currency: { value: "USD" }
      },
      {
        ...metadata({ id: "400", sourceObject: "Account" }),
        name: "Service Revenue",
        accountType: "Income",
        classification: "Income",
        active: true,
        currency: { value: "USD" }
      }
    ],
    ledger_entries: [
      {
        ...metadata({ id: "ledger_payment_700_1", sourceObject: "Payment" }),
        transactionId: "payment_700",
        transactionType: "payment",
        lineId: "1",
        transactionDate: "2026-08-13",
        postingType: overrides.postingType ?? "Debit",
        amount: overrides.firstAmount ?? 1250,
        account: { value: "100", name: "Operating Cash" },
        currency: { value: "USD" }
      },
      {
        ...metadata({ id: "ledger_payment_700_2", sourceObject: "Payment" }),
        transactionId: "payment_700",
        transactionType: "payment",
        lineId: "2",
        transactionDate: "2026-08-13",
        postingType: "Credit",
        amount: overrides.secondAmount ?? 1250,
        account: { value: "400", name: "Service Revenue" },
        currency: { value: "USD" }
      }
    ],
    transactions: [
      {
        ...metadata({ id: "payment_700", sourceObject: "Payment" }),
        transactionType: "payment",
        transactionDate: "2026-08-13",
        amount: 1250,
        unappliedAmount: 250,
        party: { value: "customer_20", name: "Acme" },
        documentNumber: "PAY-700"
      }
    ],
    transaction_lines: [
      {
        ...metadata({ id: "payment_700:1", sourceObject: "Payment" }),
        transactionType: "payment",
        transactionId: "payment_700",
        lineId: "1",
        lineIndex: 0,
        lineOrder: 1,
        amount: 1250,
        quantity: 5,
        unitAmount: 250,
        taxCode: { value: "NON", name: "Non-taxable" },
        linkedTransactions: [{ transactionId: "invoice_600", transactionType: "Invoice" }]
      }
    ]
  };
}

function commercialFixtureLines(amount: string) {
  return [{ lineNumber: 1, sourceLineId: "1", sourceAmount: amount, sourceQuantity: "1", sourceUnitAmount: amount, accountRef: { sourceObjectId: "400" }, postings: [] }];
}

function omitFixtureField<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _omitted, ...remaining } = value;
  return remaining;
}
