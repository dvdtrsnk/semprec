import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  mintMcpRunCredential,
  seedSystem,
  withTransaction,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const blobDir = join(tmpdir(), `semprec-test-page-http-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

/**
 * The shared harness of the page HTTP tests: a runtime-role pool (so row-level security applies, never the
 * superuser pool), two tenants each with a signed-in user, and the real dispatcher on a loopback port.
 * `start` opens the pools once, `reset` rebuilds the tenants, users and server for one test, `stop` releases
 * everything; a failure in one release never hides another.
 */
export class PageHttpHarness {
  admin!: Pool;
  runtime!: Pool;
  baseUrl = "";
  tenantA = "";
  tenantB = "";
  headersA: { Authorization: string } = { Authorization: "" };
  headersB: { Authorization: string } = { Authorization: "" };
  private server: Server | undefined;

  async start(): Promise<void> {
    this.admin = getTestPool();
    this.runtime = await createRuntimeRolePool(this.admin, "semprec_data");
  }

  async reset(): Promise<void> {
    await this.closeServer();
    await resetDatabase(this.admin);
    this.tenantA = await createTestTenant(this.admin);
    this.tenantB = await createTestTenant(this.admin);
    [this.headersA, this.headersB] = await Promise.all([this.signIn(this.tenantA), this.signIn(this.tenantB)]);
    const dispatch = await createDispatcher(this.runtime, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(blobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    const server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    this.server = server;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled([this.closeServer(), this.runtime?.end(), this.admin?.end()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Page HTTP harness cleanup failed", { cause: errors[0] });
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private async signIn(tenantId: string): Promise<{ Authorization: string }> {
    const email = `${randomUUID()}@example.com`;
    await createUser(this.admin, { email, passwordHash: await hashPassword(PASSWORD), tenantId });
    const { token } = await login(this.admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    return { Authorization: `Bearer ${token}` };
  }

  /** A plain item of a database of its own in `tenantId`: the host of the page under test. */
  async createHost(tenantId: string): Promise<string> {
    return runInTenant(tenantId, async () => {
      const chokePoint = createChokePoint(this.runtime);
      const database = await chokePoint.createDatabase({ name: `Pages of ${randomUUID()}` });
      return (await chokePoint.createItem({ databaseId: database.id, properties: {} })).id;
    });
  }

  /**
   * A restricted MCP run credential of a project agent of `tenantId` with exactly `capabilities`, acting for the
   * tenant's user; returns the bearer token a caller presents.
   */
  async mintRunCredential(
    tenantId: string,
    capabilities: Array<"core.page.read" | "core.page.write">,
  ): Promise<string> {
    await runInTenant(tenantId, () => seedSystem(this.runtime));
    const minted = await runInTenant(tenantId, async () => {
      const chokePoint = createChokePoint(this.runtime);
      const projects = (await chokePoint.listDatabases()).find((database) => database.ownerModuleId === "projects");
      if (!projects) throw new Error("Projects database was not seeded");
      const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
      const { rows } = await this.runtime.query<{ id: string }>(`SELECT id FROM users WHERE tenant_id = $1`, [
        tenantId,
      ]);
      const userId = rows[0]?.id;
      if (!userId) throw new Error("Missing tenant user");
      return withTransaction(this.runtime, (client) =>
        mintMcpRunCredential(client, { projectItemId: project.id, capabilities, userId }),
      );
    });
    return minted.token;
  }

  /** The id of the page document of `itemId`; throws when there is none. */
  async docIdOf(tenantId: string, itemId: string): Promise<string> {
    const { rows } = await runInTenant(tenantId, () =>
      this.runtime.query<{ id: string }>(`SELECT id FROM docs WHERE item_id = $1`, [itemId]),
    );
    const row = rows[0];
    if (!row) throw new Error(`Item ${itemId} has no document`);
    return row.id;
  }
}
