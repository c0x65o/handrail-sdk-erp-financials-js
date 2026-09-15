import { ErpFinancialsError } from "./sdk-errors.js";

import type { DecimalString, DimensionRef, IsoDate } from "./canonical-model.js";

export type CommercialDocumentLineInput = {
  readonly amount: DecimalString;
  readonly itemId?: string;
  readonly description?: string;
  readonly quantity?: DecimalString;
  readonly unitAmount?: DecimalString;
  /** Exact per-unit cost provenance; never participates in customer-facing line arithmetic. */
  readonly unitCost?: DecimalString;
  readonly discountAmount?: DecimalString;
  readonly taxCode?: string;
  readonly taxAmount?: DecimalString;
  readonly servicePeriodStart?: IsoDate;
  readonly servicePeriodEnd?: IsoDate;
  readonly dimensionRefs?: readonly DimensionRef[];
};

export type NormalizedCommercialDocumentLine = {
  readonly amount: DecimalString;
  readonly itemId?: string;
  readonly description?: string;
  readonly quantity: DecimalString;
  readonly unitAmount: DecimalString;
  readonly unitCost?: DecimalString;
  readonly discountAmount: DecimalString;
  readonly taxCode?: string;
  readonly taxAmount: DecimalString;
  readonly servicePeriodStart?: IsoDate;
  readonly servicePeriodEnd?: IsoDate;
  readonly dimensionRefs: readonly DimensionRef[];
};

/**
 * Normalizes and proves line arithmetic with integer math. Quantity supports up
 * to four fractional digits, as do unit rates; money supports two. Extended price is rounded
 * half-up to cents before discounts and tax are applied.
 */
export function normalizeCommercialDocumentLine(
  input: CommercialDocumentLineInput,
  field = "line",
  unitRatePrecision: 2 | 4 = 4
): NormalizedCommercialDocumentLine {
  const amountMinor = parseMoney(input.amount, `${field}.amount`, false);
  if ((input.quantity === undefined) !== (input.unitAmount === undefined)) {
    throw new ErpFinancialsError("invalid_input", `${field}.quantity and ${field}.unitAmount must be supplied together`);
  }
  const quantity = input.quantity ?? "1";
  const unitAmount = input.unitAmount ?? input.amount;
  const discountAmount = input.discountAmount ?? "0.00";
  const taxAmount = input.taxAmount ?? "0.00";
  const quantityScaled = parseQuantity(quantity, `${field}.quantity`);
  const unitScaled = parseUnitRate(unitAmount, `${field}.unitAmount`, unitRatePrecision);
  const unitCost = input.unitCost === undefined
    ? undefined
    : parseExactUnitCost(input.unitCost, `${field}.unitCost`);
  const discountMinor = parseMoney(discountAmount, `${field}.discountAmount`, true);
  const taxMinor = parseMoney(taxAmount, `${field}.taxAmount`, true);
  const extendedMinor = divideRoundedHalfUp(quantityScaled * unitScaled, 1_000_000n);
  const calculatedMinor = extendedMinor - discountMinor + taxMinor;
  if (discountMinor > extendedMinor) {
    throw new ErpFinancialsError("invalid_input", `${field}.discountAmount exceeds the extended price`);
  }
  if (calculatedMinor !== amountMinor) {
    throw new ErpFinancialsError(
      "invalid_input",
      `${field}.amount must equal quantity × unitAmount − discountAmount + taxAmount`,
      {
        details: {
          actualAmount: money(amountMinor),
          calculatedAmount: money(calculatedMinor),
          field
        }
      }
    );
  }
  if (input.servicePeriodStart !== undefined) assertDate(input.servicePeriodStart, `${field}.servicePeriodStart`);
  if (input.servicePeriodEnd !== undefined) assertDate(input.servicePeriodEnd, `${field}.servicePeriodEnd`);
  if (
    input.servicePeriodStart !== undefined &&
    input.servicePeriodEnd !== undefined &&
    input.servicePeriodStart > input.servicePeriodEnd
  ) {
    throw new ErpFinancialsError("invalid_input", `${field} service period start must be on or before its end`);
  }
  if (input.itemId !== undefined) assertNonEmpty(input.itemId, `${field}.itemId`);
  if (input.taxCode !== undefined) assertNonEmpty(input.taxCode, `${field}.taxCode`);

  return {
    amount: money(amountMinor),
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
    ...(input.description === undefined ? {} : { description: input.description }),
    quantity: quantityString(quantityScaled),
    unitAmount: unitRateString(unitScaled),
    ...(unitCost === undefined ? {} : { unitCost }),
    discountAmount: money(discountMinor),
    ...(input.taxCode === undefined ? {} : { taxCode: input.taxCode }),
    taxAmount: money(taxMinor),
    ...(input.servicePeriodStart === undefined ? {} : { servicePeriodStart: input.servicePeriodStart }),
    ...(input.servicePeriodEnd === undefined ? {} : { servicePeriodEnd: input.servicePeriodEnd }),
    dimensionRefs: input.dimensionRefs ?? []
  };
}

function parseUnitRate(value: string, field: string, precision: 2 | 4): bigint {
  const match = new RegExp(`^(\\d+)(?:\\.(\\d{1,${String(precision)}}))?$`, "u").exec(value);
  if (match?.[1] === undefined) {
    throw new ErpFinancialsError("invalid_input", `${field} must be a nonnegative decimal with at most ${precision === 4 ? "four" : "two"} fractional digits`);
  }
  return BigInt(match[1]) * 10_000n + BigInt((match[2] ?? "").padEnd(4, "0"));
}

function unitRateString(value: bigint): DecimalString {
  const fraction = (value % 10_000n).toString().padStart(4, "0").replace(/0+$/u, "").padEnd(2, "0");
  return `${(value / 10_000n).toString()}.${fraction}`;
}

function parseExactUnitCost(value: string, field: string): DecimalString {
  if (!/^\d+(?:\.\d{1,6})?$/u.test(value)) {
    throw new ErpFinancialsError(
      "invalid_input",
      `${field} must be a nonnegative decimal with at most six fractional digits`
    );
  }
  return value;
}

function parseMoney(value: string, field: string, allowZero: boolean): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(value);
  if (match?.[1] === undefined) {
    throw new ErpFinancialsError("invalid_input", `${field} must be a nonnegative decimal with at most two fractional digits`);
  }
  const result = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (!allowZero && result === 0n) throw new ErpFinancialsError("invalid_input", `${field} must be greater than zero`);
  return result;
}

function parseQuantity(value: string, field: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/u.exec(value);
  if (match?.[1] === undefined) {
    throw new ErpFinancialsError("invalid_input", `${field} must be a positive decimal with at most four fractional digits`);
  }
  const result = BigInt(match[1]) * 10_000n + BigInt((match[2] ?? "").padEnd(4, "0"));
  if (result === 0n) throw new ErpFinancialsError("invalid_input", `${field} must be greater than zero`);
  return result;
}

function divideRoundedHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function money(value: bigint): DecimalString {
  return `${(value / 100n).toString()}.${(value % 100n).toString().padStart(2, "0")}`;
}

function quantityString(value: bigint): DecimalString {
  const whole = value / 10_000n;
  const fraction = (value % 10_000n).toString().padStart(4, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

function assertDate(value: string, field: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ErpFinancialsError("invalid_input", `${field} must be a valid ISO date`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new ErpFinancialsError("invalid_input", `${field} must not be empty`);
}
