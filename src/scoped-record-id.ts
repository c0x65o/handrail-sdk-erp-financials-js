import { createHash } from "node:crypto";

/** Internal identity algorithm shared by native commands and bounded reads. */
export function scopedRecordId(context: { readonly tenantId: string; readonly sourceId: string }, kind: string, key: string): string {
  const digest = createHash("sha256")
    .update([context.tenantId, context.sourceId, kind, key].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `${kind}_${digest}`;
}

