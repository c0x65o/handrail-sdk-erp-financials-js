export type ErpFinancialsErrorCode =
  | "authorization_context_invalid"
  | "currency_not_supported"
  | "fiscal_period_closed"
  | "fiscal_period_closing"
  | "idempotency_conflict"
  | "invalid_account_hierarchy"
  | "invalid_input"
  | "missing_account"
  | "missing_book"
  | "missing_document"
  | "missing_party"
  | "optimistic_concurrency_conflict"
  | "provider_dependency"
  | "posting_unbalanced"
  | "reconciliation_conflict"
  | "scope_mismatch"
  | "terminal_state_conflict"
  | "unsupported_operation";

export type ErpFinancialsErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Stable SDK error boundary. Consumers should branch on `code`, never parse the
 * human-readable message. `details` is deliberately scalar and safe to return
 * from an application API after the host has applied its own authorization.
 */
export class ErpFinancialsError extends Error {
  readonly code: ErpFinancialsErrorCode;
  readonly retryable: boolean;
  readonly details: ErpFinancialsErrorDetails;

  constructor(
    code: ErpFinancialsErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly details?: ErpFinancialsErrorDetails;
      readonly cause?: unknown;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ErpFinancialsError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
    Object.setPrototypeOf(this, ErpFinancialsError.prototype);
  }
}

export function isErpFinancialsError(value: unknown): value is ErpFinancialsError {
  return value instanceof ErpFinancialsError;
}

export function erpFinancialsError(
  code: ErpFinancialsErrorCode,
  message: string,
  details: ErpFinancialsErrorDetails = {},
  retryable = false
): ErpFinancialsError {
  return new ErpFinancialsError(code, message, { details, retryable });
}
