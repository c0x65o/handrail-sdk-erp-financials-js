import type { AccountClassification } from "./canonical-model.js";
import { ErpFinancialsError } from "./sdk-errors.js";

/** Execution policy for new invoice drafts/postings, not a mutable financial fact.
 * Omitting it preserves the generic consumer's existing classification behavior.
 * Historical command replays return their original evidence without re-execution. */
export type InvoiceAccountPolicy = {
  readonly revenueClassifications: readonly AccountClassification[];
  readonly receivableClassifications: readonly AccountClassification[];
  readonly taxClassifications?: readonly AccountClassification[];
  readonly discountClassifications?: readonly AccountClassification[];
};

export function normalizeInvoiceAccountPolicy(value: unknown): InvoiceAccountPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["revenueClassifications", "receivableClassifications", "taxClassifications", "discountClassifications"].includes(key))) {
    throw new ErpFinancialsError("invalid_input", "Invoice account policy must contain supported classification lists");
  }
  const allowed = new Set<AccountClassification>(["asset", "liability", "equity", "income", "cost_of_goods_sold", "expense", "other_income", "other_expense"]);
  const classes = (input: unknown): readonly AccountClassification[] => {
    if (!Array.isArray(input) || !input.length || input.some(item => !allowed.has(item as AccountClassification))) {
      throw new ErpFinancialsError("invalid_input", "Invoice account policy requires nonempty supported classifications");
    }
    return Object.freeze([...new Set(input as AccountClassification[])].sort());
  };
  const policy = value as Record<string, unknown>;
  return Object.freeze({ revenueClassifications: classes(policy.revenueClassifications), receivableClassifications: classes(policy.receivableClassifications),
    ...(policy.taxClassifications === undefined ? {} : {taxClassifications:classes(policy.taxClassifications)}),
    ...(policy.discountClassifications === undefined ? {} : {discountClassifications:classes(policy.discountClassifications)}) });
}
