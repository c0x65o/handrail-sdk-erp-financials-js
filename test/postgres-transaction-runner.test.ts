import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createErpFinancialsSdk, createPostgresTransactionRunner } from "../src/index.js";
import type { PostgresQueryResult } from "../src/index.js";
class Client extends EventEmitter {
  readonly calls: string[] = [];
  readonly released: (Error | boolean | undefined)[] = [];
  before: (sql: string) => void = () => undefined;
  async query<Row extends Record<string, unknown>>(sql: string): Promise<PostgresQueryResult<Row>> {
    await Promise.resolve();
    this.calls.push(sql); this.before(sql); return { rows: [], rowCount: 0 };
  }
  release(error?: Error | boolean) { this.released.push(error); }
}
describe("default PostgreSQL transaction boundary", () => {
  it("preserves original work failure when rollback fails and discards the connection", async () => {
    const client = new Client(), original = Error("original command failure");
    client.before = sql => { if (sql === "rollback") throw Error("rollback connection failure"); };
    await expect(createPostgresTransactionRunner({ connect: () => Promise.resolve(client) }).transaction(() => Promise.reject(original))).rejects.toBe(original);
    expect(client.calls).toEqual(["begin", "rollback"]); expect(client.released).toEqual([true]); expect(client.listenerCount("error")).toBe(0);
  });
  it("handles checked-out connection errors and refuses to commit swallowed failures", async () => {
    const client = new Client(), original = Error("socket closed"); let observed = 0;
    const pending = createPostgresTransactionRunner({ connect: () => Promise.resolve(client) }).transaction(async () => {
      await Promise.resolve();
      observed = client.listenerCount("error"); client.emit("error", original); return "must not commit";
    });
    await expect(pending).rejects.toBe(original); expect(observed).toBe(1);
    expect(client.calls).toEqual(["begin", "rollback"]); expect(client.released).toEqual([original]); expect(client.listenerCount("error")).toBe(0);
  });
  it("treats a connection error during commit acknowledgement as uncertain", async () => {
    const client = new Client(), original = Error("socket failed during commit");
    client.before = sql => { if (sql === "commit") client.emit("error", original); };
    await expect(createPostgresTransactionRunner({ connect: () => Promise.resolve(client) }).transaction(() => Promise.resolve("written"))).rejects.toBe(original);
    expect(client.calls).toEqual(["begin", "commit", "rollback"]); expect(client.released).toEqual([original]);
  });
  it("does not mask or automatically retry an uncertain commit", async () => {
    const client = new Client(), original = Error("commit acknowledgement lost"); let calls = 0;
    client.before = sql => { if (sql === "commit") throw original; if (sql === "rollback") throw Error("connection unavailable"); };
    await expect(createPostgresTransactionRunner({ connect: () => Promise.resolve(client) }).transaction(() => { calls++; return Promise.resolve("written"); })).rejects.toBe(original);
    expect(calls).toBe(1); expect(client.calls).toEqual(["begin", "commit", "rollback"]); expect(client.released).toEqual([true]);
  });
  it("discards a connection if begin fails without invoking user work", async () => {
    const client = new Client(), original = Error("begin connection lost"); let calls = 0;
    client.before = sql => { if (sql === "begin") throw original; };
    await expect(createPostgresTransactionRunner({ connect: () => Promise.resolve(client) }).transaction(() => { calls++; return Promise.resolve(); })).rejects.toBe(original);
    expect(calls).toBe(0); expect(client.calls).toEqual(["begin"]); expect(client.released).toEqual([true]);
  });
  it("returns a healthy client once and removes only its own error listener", async () => {
    const client = new Client(), existing = () => undefined; client.on("error", existing);
    const runner = createPostgresTransactionRunner({ connect: () => Promise.resolve(client) });
    await expect(runner.transaction(() => Promise.resolve("value"))).resolves.toBe("value");
    expect(client.calls).toEqual(["begin", "commit"]); expect(client.released).toEqual([undefined]); expect(client.listeners("error")).toEqual([existing]);
  });
  it("retains compatibility with query/release clients without event hooks", async () => {
    const calls: string[] = [], releases: unknown[] = [];
    const runner = createPostgresTransactionRunner({ connect: () => Promise.resolve({
      query: () => { calls.push("query"); return Promise.resolve({ rows: [] }); }, release: (error?: Error | boolean) => { releases.push(error); },
    }) });
    await expect(runner.transaction(() => Promise.resolve("done"))).resolves.toBe("done");
    expect(calls).toHaveLength(2); expect(releases).toEqual([undefined]);
  });
  it("preserves failure even when a custom rollback throws before returning a promise", async () => {
    const original = Error("work failed"), releases: unknown[] = [];
    const runner = createPostgresTransactionRunner({ connect: () => Promise.resolve({
      query: (sql: string) => { if (sql === "rollback") throw Error("synchronous driver error"); return Promise.resolve({ rows: [] }); },
      release: (error?: Error | boolean) => { releases.push(error); },
    }) });
    await expect(runner.transaction(() => Promise.reject(original))).rejects.toBe(original);
    expect(releases).toEqual([true]);
  });
  it("uses the same failure boundary when the SDK facade receives a pool directly", async () => {
    const client = new Client(), original = Error("statement read failed");
    client.before = sql => { if (sql.includes("from erp_financials.bank_statements")) throw original; if (sql === "rollback") throw Error("rollback lost"); };
    const sdk = createErpFinancialsSdk({ database: { connect: () => Promise.resolve(client) }, tenantId: "t", companyId: "c", bookId: "b", writeSourceId: "s", currencyCode: "USD" });
    await expect(sdk.bankStatements.find("statement")).rejects.toBe(original);
    expect(client.released).toEqual([true]); expect(client.calls.filter(sql => sql === "begin")).toHaveLength(1); expect(client.listenerCount("error")).toBe(0);
  });
});
