import { describe, expect, it } from "vitest";

import {
  AccountHierarchyValidationError,
  buildAccountHierarchyRollupLines
} from "../src/index.js";

import type {
  Account,
  AccountHierarchyRollupLineAmount,
  ReportSnapshotLine,
  SafeSourcePayloadRef
} from "../src/index.js";

const tenantId = "tenant_rollup_lines";
const sourceId = "source_rollup_lines";
const reportName = "profit_and_loss";
const reportSnapshotId = "snapshot:tenant_rollup_lines:profit_and_loss";

describe("account hierarchy rollup report lines", () => {
  it("emits stable parent and child lines with subtree totals and parentReportLineId links", () => {
    const lines = buildAccountHierarchyRollupLines({
      ...baseInput(),
      accounts: hierarchyAccounts(),
      accountAmounts: [
        amount("acct_grandchild", "30.00", "post_grandchild"),
        amount("acct_sibling", "5.00", "post_sibling"),
        amount("acct_parent", "10.00", "post_parent"),
        amount("acct_child", "20.00", "post_child")
      ]
    });

    expect(lineSummary(lines)).toEqual([
      {
        id: `${reportSnapshotId}:line:account:acct_parent`,
        parentId: undefined,
        label: "6000 Operating Expenses",
        amount: "65.00",
        sortOrder: 10,
        accountIds: ["acct_child", "acct_grandchild", "acct_parent", "acct_sibling"],
        postingIds: ["post_child", "post_grandchild", "post_parent", "post_sibling"]
      },
      {
        id: `${reportSnapshotId}:line:account:acct_child`,
        parentId: `${reportSnapshotId}:line:account:acct_parent`,
        label: "6100 Admin",
        amount: "50.00",
        sortOrder: 20,
        accountIds: ["acct_child", "acct_grandchild"],
        postingIds: ["post_child", "post_grandchild"]
      },
      {
        id: `${reportSnapshotId}:line:account:acct_grandchild`,
        parentId: `${reportSnapshotId}:line:account:acct_child`,
        label: "6110 Software",
        amount: "30.00",
        sortOrder: 30,
        accountIds: ["acct_grandchild"],
        postingIds: ["post_grandchild"]
      },
      {
        id: `${reportSnapshotId}:line:account:acct_sibling`,
        parentId: `${reportSnapshotId}:line:account:acct_parent`,
        label: "6200 Facilities",
        amount: "5.00",
        sortOrder: 40,
        accountIds: ["acct_sibling"],
        postingIds: ["post_sibling"]
      }
    ]);
    expect(lines[0]?.drilldownRef.query).toMatchObject({
      kind: "ledger_postings",
      tenantId,
      sourceId,
      accountingBasis: "accrual",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      accountIds: ["acct_child", "acct_grandchild", "acct_parent", "acct_sibling"]
    });
  });

  it("keeps line ids and output order independent of account and amount input order", () => {
    const forward = buildAccountHierarchyRollupLines({
      ...baseInput(),
      accounts: hierarchyAccounts(),
      accountAmounts: [
        amount("acct_parent", "10.00", "post_parent"),
        amount("acct_child", "20.00", "post_child"),
        amount("acct_grandchild", "30.00", "post_grandchild"),
        amount("acct_sibling", "5.00", "post_sibling")
      ]
    });
    const reversed = buildAccountHierarchyRollupLines({
      ...baseInput(),
      accounts: [...hierarchyAccounts()].reverse(),
      accountAmounts: [
        amount("acct_sibling", "5.00", "post_sibling"),
        amount("acct_grandchild", "30.00", "post_grandchild"),
        amount("acct_child", "20.00", "post_child"),
        amount("acct_parent", "10.00", "post_parent")
      ]
    });

    expect(lineSummary(reversed)).toEqual(lineSummary(forward));
  });

  it("keeps account-based line ids stable when hierarchy depth changes", () => {
    const shallow = buildAccountHierarchyRollupLines({
      ...baseInput(),
      accounts: [
        account("acct_depth_parent", "6000", "Depth Parent"),
        account("acct_depth_child", "6100", "Depth Child", "acct_depth_parent"),
        account("acct_depth_leaf", "6110", "Depth Leaf", "acct_depth_child")
      ],
      accountAmounts: [amount("acct_depth_leaf", "42.00", "post_depth_leaf")]
    });
    const deeper = buildAccountHierarchyRollupLines({
      ...baseInput(),
      accounts: [
        account("acct_depth_leaf", "6110", "Depth Leaf", "acct_depth_child"),
        account("acct_depth_child", "6100", "Depth Child", "acct_depth_group"),
        account("acct_depth_group", "6050", "Depth Group", "acct_depth_parent"),
        account("acct_depth_parent", "6000", "Depth Parent")
      ],
      accountAmounts: [amount("acct_depth_leaf", "42.00", "post_depth_leaf")]
    });

    expect(lineIdsByAccount(shallow, ["acct_depth_parent", "acct_depth_child", "acct_depth_leaf"])).toEqual({
      acct_depth_parent: `${reportSnapshotId}:line:account:acct_depth_parent`,
      acct_depth_child: `${reportSnapshotId}:line:account:acct_depth_child`,
      acct_depth_leaf: `${reportSnapshotId}:line:account:acct_depth_leaf`
    });
    expect(lineIdsByAccount(deeper, ["acct_depth_parent", "acct_depth_child", "acct_depth_leaf"])).toEqual(
      lineIdsByAccount(shallow, ["acct_depth_parent", "acct_depth_child", "acct_depth_leaf"])
    );
    expect(requiredLine(shallow, "acct_depth_child").parentReportLineId).toBe(
      `${reportSnapshotId}:line:account:acct_depth_parent`
    );
    expect(requiredLine(deeper, "acct_depth_group").parentReportLineId).toBe(
      `${reportSnapshotId}:line:account:acct_depth_parent`
    );
    expect(requiredLine(deeper, "acct_depth_child").parentReportLineId).toBe(
      `${reportSnapshotId}:line:account:acct_depth_group`
    );
    expect(deeper.map((line) => [line.accountId, line.sortOrder])).toEqual([
      ["acct_depth_parent", 10],
      ["acct_depth_group", 20],
      ["acct_depth_child", 30],
      ["acct_depth_leaf", 40]
    ]);
  });

  it("orders visible siblings by account number before deterministic name and account id fallback", () => {
    const lines = buildAccountHierarchyRollupLines({
      ...baseInput(),
      accounts: [
        account("acct_order_beta", undefined, "Beta", "acct_order_parent"),
        account("acct_order_10", "10", "Ten", "acct_order_parent"),
        account("acct_order_alpha_b", undefined, "Alpha", "acct_order_parent"),
        account("acct_order_parent", "5000", "Ordering Parent"),
        account("acct_order_2", "2", "Two", "acct_order_parent"),
        account("acct_order_alpha_a", undefined, "Alpha", "acct_order_parent")
      ],
      accountAmounts: [
        amount("acct_order_alpha_a", "1.00", "post_order_alpha_a"),
        amount("acct_order_10", "1.00", "post_order_10"),
        amount("acct_order_beta", "1.00", "post_order_beta"),
        amount("acct_order_2", "1.00", "post_order_2"),
        amount("acct_order_alpha_b", "1.00", "post_order_alpha_b")
      ]
    });

    expect(lines.map((line) => [line.accountId, line.sortOrder])).toEqual([
      ["acct_order_parent", 10],
      ["acct_order_2", 20],
      ["acct_order_10", 30],
      ["acct_order_alpha_a", 40],
      ["acct_order_alpha_b", 50],
      ["acct_order_beta", 60]
    ]);
    expect(lines.slice(1).map((line) => line.parentReportLineId)).toEqual([
      `${reportSnapshotId}:line:account:acct_order_parent`,
      `${reportSnapshotId}:line:account:acct_order_parent`,
      `${reportSnapshotId}:line:account:acct_order_parent`,
      `${reportSnapshotId}:line:account:acct_order_parent`,
      `${reportSnapshotId}:line:account:acct_order_parent`
    ]);
  });

  it("keeps zero-amount parents only when they have evidence or visible descendants", () => {
    const lines = buildAccountHierarchyRollupLines({
      ...baseInput(),
      accounts: [
        account("acct_zero_empty_child", "7010", "Zero Empty Child", "acct_zero_empty_parent"),
        account("acct_zero_evidence", "7040", "Zero Evidence"),
        account("acct_zero_leaf", "7035", "Zero Leaf", "acct_zero_mid"),
        account("acct_zero_empty_parent", "7000", "Zero Empty Parent"),
        account("acct_zero_no_evidence", "7020", "Zero No Evidence"),
        account("acct_zero_mid", undefined, "Zero Mid", "acct_zero_visible_parent"),
        account("acct_zero_visible_parent", "7030", "Zero Visible Parent")
      ],
      accountAmounts: [
        amountWithoutEvidence("acct_zero_no_evidence", "0.00"),
        amount("acct_zero_leaf", "7.00", "post_zero_leaf"),
        amount("acct_zero_evidence", "0.00", "post_zero_evidence")
      ]
    });

    expect(lines.map((line) => [line.accountId, line.amount, line.parentReportLineId, line.sortOrder])).toEqual([
      ["acct_zero_visible_parent", "7.00", undefined, 10],
      ["acct_zero_mid", "7.00", `${reportSnapshotId}:line:account:acct_zero_visible_parent`, 20],
      ["acct_zero_leaf", "7.00", `${reportSnapshotId}:line:account:acct_zero_mid`, 30],
      ["acct_zero_evidence", "0.00", undefined, 40]
    ]);
    expect(lines.some((line) => line.accountId === "acct_zero_empty_parent")).toBe(false);
    expect(lines.some((line) => line.accountId === "acct_zero_empty_child")).toBe(false);
    expect(lines.some((line) => line.accountId === "acct_zero_no_evidence")).toBe(false);
    expect(requiredLine(lines, "acct_zero_visible_parent").drilldownRef.accountIds).toEqual([
      "acct_zero_leaf",
      "acct_zero_mid",
      "acct_zero_visible_parent"
    ]);
    expect(requiredLine(lines, "acct_zero_evidence").drilldownRef.postingIds).toEqual(["post_zero_evidence"]);
  });

  it("rejects invalid canonical hierarchy before emitting report lines", () => {
    expect(() =>
      buildAccountHierarchyRollupLines({
        ...baseInput(),
        accounts: [account("acct_orphan", "6999", "Orphan", "acct_missing_parent")],
        accountAmounts: [amount("acct_orphan", "1.00", "post_orphan")]
      })
    ).toThrow(AccountHierarchyValidationError);
  });

  it("uses canonical parentAccountId and labels instead of provider-specific names", () => {
    const parent = account("acct_provider_parent", "6000", "Operating Expenses");
    const implicitProviderChild = providerDecoratedAccount({
      ...account("acct_provider_child", undefined, "Provider-Neutral Label"),
      sourceAccountId: "provider_child_1"
    });
    const explicitCanonicalChild = providerDecoratedAccount({
      ...account("acct_canonical_child", undefined, "Canonical Child", parent.accountId),
      sourceAccountId: "provider_child_2"
    });
    const lines = buildAccountHierarchyRollupLines({
      ...baseInput(),
      accounts: [implicitProviderChild, explicitCanonicalChild, parent],
      accountAmounts: [
        amount("acct_provider_parent", "1.00", "post_parent"),
        amount("acct_provider_child", "2.00", "post_provider_child"),
        amount("acct_canonical_child", "3.00", "post_canonical_child")
      ]
    });

    const implicitLine = requiredLine(lines, "acct_provider_child");
    const explicitLine = requiredLine(lines, "acct_canonical_child");

    expect(implicitLine.label).toBe("Provider-Neutral Label");
    expect(implicitLine.parentReportLineId).toBeUndefined();
    expect(explicitLine.label).toBe("Canonical Child");
    expect(explicitLine.parentReportLineId).toBe(`${reportSnapshotId}:line:account:acct_provider_parent`);
  });

  it("does not infer hierarchy from labels, account numbers, source ids, or provider payload metadata", () => {
    const apparentParent = providerDecoratedAccount(
      {
        ...account("acct_false_parent", "6000", "Operating Expenses"),
        sourceAccountId: "provider:6000"
      },
      {
        fullyQualifiedName: "Operating Expenses",
        displayName: "Operating Expenses",
        sourcePayloadRef: {
          sourceObjectType: "Account",
          sourceObjectId: "provider:6000",
          preview: {
            fullyQualifiedName: "Operating Expenses"
          }
        }
      }
    );
    const apparentChild = providerDecoratedAccount(
      {
        ...account("acct_false_child", "6000.10", "Operating Expenses:Software"),
        sourceAccountId: "provider:6000:software"
      },
      {
        fullyQualifiedName: "Operating Expenses:Software",
        displayName: "Software",
        ParentRef: { value: "provider:6000", name: "Operating Expenses" },
        sourcePayloadRef: {
          sourceObjectType: "Account",
          sourceObjectId: "provider:6000:software",
          preview: {
            fullyQualifiedName: "Operating Expenses:Software",
            ParentRef: { value: "provider:6000", name: "Operating Expenses" },
            accountNumberPath: "6000.10"
          }
        }
      }
    );
    const lines = buildAccountHierarchyRollupLines({
      ...baseInput(),
      accounts: [apparentChild, apparentParent],
      accountAmounts: [
        amount(apparentParent.accountId, "4.00", "post_false_parent"),
        amount(apparentChild.accountId, "9.00", "post_false_child")
      ]
    });

    const parentLine = requiredLine(lines, apparentParent.accountId);
    const childLine = requiredLine(lines, apparentChild.accountId);

    expect(parentLine.parentReportLineId).toBeUndefined();
    expect(childLine.parentReportLineId).toBeUndefined();
    expect(parentLine.amount).toBe("4.00");
    expect(childLine.amount).toBe("9.00");
    expect(parentLine.drilldownRef.accountIds).toEqual(["acct_false_parent"]);
    expect(childLine.drilldownRef.accountIds).toEqual(["acct_false_child"]);
    expect(lines.map((line) => line.accountId)).toEqual(["acct_false_parent", "acct_false_child"]);
  });

  it("uses only canonical parentAccountId when provider metadata conflicts with the canonical edge", () => {
    const canonicalParent = providerDecoratedAccount(
      {
        ...account("acct_canonical_parent", "7000", "Canonical Parent"),
        sourceAccountId: "provider:canonical-parent"
      },
      {
        fullyQualifiedName: "Canonical Parent"
      }
    );
    const providerMetadataParent = providerDecoratedAccount(
      {
        ...account("acct_provider_metadata_parent", "7100", "Provider Metadata Parent"),
        sourceAccountId: "provider:metadata-parent"
      },
      {
        fullyQualifiedName: "Provider Metadata Parent"
      }
    );
    const child = providerDecoratedAccount(
      {
        ...account("acct_conflicting_child", "7100.10", "Provider Metadata Parent:Conflicting Child", canonicalParent.accountId),
        sourceAccountId: "provider:metadata-parent:conflicting-child"
      },
      {
        fullyQualifiedName: "Provider Metadata Parent:Conflicting Child",
        ParentRef: { value: providerMetadataParent.sourceAccountId, name: providerMetadataParent.name },
        sourcePayloadRef: {
          sourceObjectType: "Account",
          sourceObjectId: "provider:metadata-parent:conflicting-child",
          preview: {
            fullyQualifiedName: "Provider Metadata Parent:Conflicting Child",
            ParentRef: { value: providerMetadataParent.sourceAccountId, name: providerMetadataParent.name }
          }
        }
      }
    );
    const lines = buildAccountHierarchyRollupLines({
      ...baseInput(),
      accounts: [providerMetadataParent, child, canonicalParent],
      accountAmounts: [
        amount(canonicalParent.accountId, "5.00", "post_canonical_parent"),
        amount(providerMetadataParent.accountId, "7.00", "post_metadata_parent"),
        amount(child.accountId, "11.00", "post_conflicting_child")
      ]
    });

    const canonicalParentLine = requiredLine(lines, canonicalParent.accountId);
    const providerMetadataParentLine = requiredLine(lines, providerMetadataParent.accountId);
    const childLine = requiredLine(lines, child.accountId);

    expect(childLine.parentReportLineId).toBe(canonicalParentLine.reportLineId);
    expect(canonicalParentLine.amount).toBe("16.00");
    expect(canonicalParentLine.drilldownRef.accountIds).toEqual(["acct_canonical_parent", "acct_conflicting_child"]);
    expect(providerMetadataParentLine.parentReportLineId).toBeUndefined();
    expect(providerMetadataParentLine.amount).toBe("7.00");
    expect(providerMetadataParentLine.drilldownRef.accountIds).toEqual(["acct_provider_metadata_parent"]);
  });
});

function baseInput() {
  return {
    tenantId,
    sourceId,
    reportSnapshotId,
    reportName,
    drilldownQuery: {
      sourceId,
      accountingBasis: "accrual" as const,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31"
    }
  };
}

function hierarchyAccounts(): readonly Account[] {
  return [
    account("acct_parent", "6000", "Operating Expenses"),
    account("acct_child", "6100", "Admin", "acct_parent"),
    account("acct_grandchild", "6110", "Software", "acct_child"),
    account("acct_sibling", "6200", "Facilities", "acct_parent")
  ];
}

function account(
  accountId: string,
  accountNumber: string | undefined,
  name: string,
  parentAccountId?: string
): Account {
  return {
    tenantId,
    sourceId,
    accountId,
    sourceAccountId: accountId.replace("acct_", ""),
    ...(accountNumber === undefined ? {} : { accountNumber }),
    name,
    type: "Expense",
    subtype: "Expense",
    classification: "expense",
    ...(parentAccountId === undefined ? {} : { parentAccountId }),
    active: true
  };
}

function providerDecoratedAccount(
  accountInput: Account,
  metadata: Record<string, unknown> = {
    fullyQualifiedName: `QuickBooks Parent:${accountInput.name}`,
    ParentRef: { value: "provider_parent_id" }
  }
): Account {
  return {
    ...accountInput,
    ...metadata
  };
}

function amount(accountId: string, amountValue: string, postingId: string): AccountHierarchyRollupLineAmount {
  return {
    accountId,
    amount: amountValue,
    section: "expense",
    postingIds: [postingId],
    sourceRefs: [sourceRef(postingId)]
  };
}

function amountWithoutEvidence(accountId: string, amountValue: string): AccountHierarchyRollupLineAmount {
  return {
    accountId,
    amount: amountValue,
    section: "expense"
  };
}

function sourceRef(postingId: string): SafeSourcePayloadRef {
  return {
    sourceObjectType: "LedgerPosting",
    sourceObjectId: postingId
  };
}

function requiredLine(lines: readonly ReportSnapshotLine[], accountId: string): ReportSnapshotLine {
  const line = lines.find((entry) => entry.accountId === accountId);
  if (line === undefined) {
    throw new Error(`missing line for ${accountId}`);
  }
  return line;
}

function lineIdsByAccount(lines: readonly ReportSnapshotLine[], accountIds: readonly string[]): Record<string, string> {
  return Object.fromEntries(accountIds.map((accountId) => [accountId, requiredLine(lines, accountId).reportLineId]));
}

function lineSummary(lines: readonly ReportSnapshotLine[]): readonly {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly label: string;
  readonly amount: string;
  readonly sortOrder: number;
  readonly accountIds: readonly string[] | undefined;
  readonly postingIds: readonly string[] | undefined;
}[] {
  return lines.map((line) => ({
    id: line.reportLineId,
    parentId: line.parentReportLineId,
    label: line.label,
    amount: line.amount,
    sortOrder: line.sortOrder,
    accountIds: line.drilldownRef.accountIds,
    postingIds: line.drilldownRef.postingIds
  }));
}
