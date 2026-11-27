import "../../domainWriteHooks.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { createSubpageWithClient } from "../../docs/pageOperations.js";
import { NotFoundError } from "../../errors.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  isProposalOptionField,
  listProposalOptions,
  PROPOSAL_OPTION_FIELDS,
  type ProposalOption,
  type ProposalOptionField,
} from "../proposalOptions.js";

let pool: Pool;
let runtime: Pool;

afterAll(async () => {
  await runtime?.end();
  await pool?.end();
});

/**
 * The options of a card's picker, read through the runtime role pool in the scope of a tenant, so row-level security
 * applies. Every case reads the list back by the ids of its own items, never by the length of a list.
 */
describe("the options of a proposal card", () => {
  let tenantA: string;
  let tenantB: string;

  const inTenant = <T>(tenant: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    runInTenant(tenant, () => withTransaction(runtime, fn));
  const inA = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => inTenant(tenantA, fn);

  async function databaseId(client: PoolClient, moduleId: string): Promise<string> {
    const database = await getDatabaseByModuleId(client, moduleId);
    if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
    return database.id;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    runtime ??= await createRuntimeRolePool(pool, "semprec_data");
    [tenantA, tenantB] = [await createTestTenant(pool), await createTestTenant(pool)];
    for (const tenant of [tenantA, tenantB])
      await runInTenant(tenant, () => seedSystem(runtime, createViewTypeRegistry()));
  });

  const createItem = (moduleId: string, properties: Record<string, unknown>, tenant = tenantA): Promise<string> =>
    inTenant(tenant, async (client) => {
      const item = await createItemWithClient(client, { databaseId: await databaseId(client, moduleId), properties });
      return item.id;
    });

  const createProject = (name: string, extra: Record<string, unknown> = {}): Promise<string> =>
    createItem("projects", { name, ...extra });

  const linkTaskToProject = (projectId: string, name = "Task"): Promise<void> =>
    inA(async (client) => {
      const tasks = await databaseId(client, "tasks");
      const property = await propertiesStore.getPropertyByKey(client, tasks, "project");
      if (!property) throw new Error("Tasks has no 'project' relation");
      const task = await createItemWithClient(client, { databaseId: tasks, properties: { name } });
      await createRelationWithClient(client, {
        relationPropertyId: property.id,
        callerItemId: task.id,
        targetItemId: projectId,
      });
    });

  const linkTaskToPerson = (personId: string): Promise<void> =>
    inA(async (client) => {
      const tasks = await databaseId(client, "tasks");
      const property = await propertiesStore.getPropertyByKey(client, tasks, "people");
      if (!property) throw new Error("Tasks has no 'people' relation");
      const task = await createItemWithClient(client, { databaseId: tasks, properties: { name: "Task" } });
      await createRelationWithClient(client, {
        relationPropertyId: property.id,
        callerItemId: task.id,
        targetItemId: personId,
      });
    });

  /** A file linked to `projectId`: an edge of another relation, which must not count for a task card. */
  const linkFileToProject = (projectId: string): Promise<void> =>
    inA(async (client) => {
      const files = await databaseId(client, "files");
      const property = await propertiesStore.getPropertyByKey(client, files, "projects");
      if (!property) throw new Error("Files has no 'projects' relation");
      const file = await createItemWithClient(client, { databaseId: files, properties: { name: "File" } });
      await createRelationWithClient(client, {
        relationPropertyId: property.id,
        callerItemId: file.id,
        targetItemId: projectId,
      });
    });

  const setStatus = (moduleId: string, itemId: string, status: string): Promise<void> =>
    inA(async (client) => {
      await updateItemWithClient(client, {
        databaseId: await databaseId(client, moduleId),
        itemId,
        propertiesPatch: { status },
      });
    });

  const trash = (moduleId: string, itemId: string): Promise<void> =>
    inA(async (client) => {
      await itemDeleteWithClient(client, await databaseId(client, moduleId), itemId, {
        queueAffinity: createActionQueueAffinity(),
      });
    });

  interface CardInput {
    proposal?: unknown;
    aiProposal?: unknown;
    userOverrides?: Record<string, Record<string, unknown>>;
  }

  /**
   * The envelopes and overrides are written directly: the cases need assistant and effective envelopes that differ in a
   * chosen way, while the tick writes them in step.
   */
  const createCard = (input: CardInput, tenant = tenantA): Promise<string> =>
    inTenant(tenant, async (client) => {
      const card = await createItemWithClient(
        client,
        {
          databaseId: await databaseId(client, "processingProposals"),
          properties: {
            kind: "inbox",
            status: "proposed",
            proposal: input.proposal ?? null,
            aiProposal: input.aiProposal ?? input.proposal ?? null,
            userOverrides: input.userOverrides ?? {},
          },
        },
        { allowedSystemKeys: ["kind", "status", "proposal", "aiProposal", "userOverrides"] },
      );
      return card.id;
    });

  const taskEnvelope = async (
    relations: Record<string, string[]> = {},
    tenant = tenantA,
  ): Promise<Record<string, unknown>> => ({
    entityKind: "database",
    target: await inTenant(tenant, (client) => databaseId(client, "tasks")),
    properties: { name: "Task" },
    ...(Object.keys(relations).length === 0 ? {} : { relations }),
  });

  const optionsOf = (
    cardId: string,
    field: ProposalOptionField,
    {
      locale = "en",
      includeDone = false,
      tenant = tenantA,
    }: { locale?: string; includeDone?: boolean; tenant?: string } = {},
  ): Promise<ProposalOption[]> =>
    inTenant(tenant, async (client) =>
      listProposalOptions(
        client,
        { processingProposalsDatabaseId: await databaseId(client, "processingProposals") },
        cardId,
        field,
        locale,
        includeDone,
      ),
    );

  /** The ids of `options` that are in `known`, in list order: the order of the items a case made, whatever else the tenant holds. */
  const orderOf = (options: ProposalOption[], known: string[]): Array<string | null> =>
    options.flatMap((option) => (option.id === null || known.includes(option.id) ? [option.id] : []));

  describe("the card's current value and its state", () => {
    it("lists an archived project that is the card's value first, disabled as archived, with the none choice last", async () => {
      const archived = await createProject("Archived one");
      const other = await createProject("Aaa other");
      await setStatus("projects", archived, "archived");
      // The card holds the archived project the way a card that went invalid does; the link cannot be made through the choke point.
      const card = await createCard({
        proposal: await taskEnvelope({ project: [archived] }),
        aiProposal: await taskEnvelope(),
      });

      const options = await optionsOf(card, "project");

      expect(options[0]).toMatchObject({ id: archived, disabled: true, disabledReason: "archived", suggested: false });
      expect(options.at(-1)).toMatchObject({ id: null, none: true, disabled: false, suggested: false });
      expect(options.map((option) => option.id)).toContain(other);
      expect(options.filter((option) => option.none)).toHaveLength(1);
    });

    it("lists a trashed project that is the card's value first, disabled as deleted", async () => {
      const trashed = await createProject("Trashed one");
      await trash("projects", trashed);
      const card = await createCard({ proposal: await taskEnvelope({ project: [trashed] }) });

      const options = await optionsOf(card, "project");

      expect(options[0]).toMatchObject({
        id: trashed,
        label: "Trashed one",
        disabled: true,
        disabledReason: "deleted",
      });
    });

    it("omits an archived and a trashed project that are not the card's value", async () => {
      const archived = await createProject("Archived");
      const trashed = await createProject("Trashed");
      const live = await createProject("Live");
      await setStatus("projects", archived, "archived");
      await trash("projects", trashed);
      const card = await createCard({ proposal: await taskEnvelope() });

      const ids = (await optionsOf(card, "project")).map((option) => option.id);

      expect(ids).toContain(live);
      expect(ids).not.toContain(archived);
      expect(ids).not.toContain(trashed);
    });

    /** The projects the seeded system modules own, which the Projects collection hides from the user. */
    const systemProjects = (): Promise<string[]> =>
      inA(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL AND properties ? 'systemActive'",
          [await databaseId(client, "projects")],
        );
        return rows.map((row) => row.id);
      });

    it.each([
      ["project", false],
      ["page", false],
      ["mcpProjects", true],
    ] as const)(
      "lists a system module's project for %s only when it is the card's value, unless the field is mcpProjects",
      async (field, listsAll) => {
        const system = await systemProjects();
        expect(system.length).toBeGreaterThan(1);
        const [held, ...others] = system as [string, ...string[]];
        const own = await createProject("Own project");
        const plain = await createCard({ proposal: await taskEnvelope() });
        const holding = await createCard({ proposal: await taskEnvelope({ project: [held] }) });

        const ids = (await optionsOf(plain, field)).map((option) => option.id);
        const heldIds = (await optionsOf(holding, "project")).map((option) => option.id);

        expect(ids).toContain(own);
        for (const id of system) expect(ids.includes(id)).toBe(listsAll);
        expect(heldIds[0]).toBe(held);
        for (const id of others) expect(heldIds).not.toContain(id);
      },
    );

    it("hides a done project that is not the card's value, and lists it as an ordinary choice with includeDone", async () => {
      const done = await createProject("Done project");
      await setStatus("projects", done, "done");
      const card = await createCard({ proposal: await taskEnvelope() });

      const hidden = await optionsOf(card, "project");
      const shown = await optionsOf(card, "project", { includeDone: true });

      expect(hidden.map((option) => option.id)).not.toContain(done);
      expect(shown.find((option) => option.id === done)).toMatchObject({ disabled: false, suggested: false });
      expect(shown.find((option) => option.id === done)).not.toHaveProperty("disabledReason");
    });

    it("lists a done project that is the card's value first and selectable without includeDone", async () => {
      const done = await createProject("Done current");
      await createProject("Aaa first by name");
      await setStatus("projects", done, "done");
      const card = await createCard({ proposal: await taskEnvelope({ project: [done] }) });

      const options = await optionsOf(card, "project");

      expect(options[0]).toMatchObject({ id: done, disabled: false });
      expect(options[0]).not.toHaveProperty("disabledReason");
    });

    it("lists the options of a card that holds no envelope, and of one whose envelope kind this release does not know", async () => {
      const project = await createProject("Lonely");
      const empty = await createCard({});
      const unknown = await createCard({ proposal: { entityKind: "futureKind", target: "x", properties: {} } });

      for (const card of [empty, unknown]) {
        const options = await optionsOf(card, "project");
        expect(options.map((option) => option.id)).toContain(project);
        expect(options.at(-1)).toMatchObject({ none: true });
        expect(options.some((option) => option.suggested)).toBe(false);
      }
    });
  });

  describe("the order", () => {
    it("puts the current value first, then the assistant's suggestion, then the target with more edges, then by name", async () => {
      const current = await createProject("Zzz current");
      const suggested = await createProject("Yyy suggested");
      const busy = await createProject("Xxx busy");
      const quiet = await createProject("Aaa quiet");
      const tied = await createProject("Bbb tied");
      await linkTaskToProject(busy);
      await linkTaskToProject(busy);
      await linkTaskToProject(quiet);
      await linkTaskToProject(tied);
      const card = await createCard({
        proposal: await taskEnvelope({ project: [current] }),
        aiProposal: await taskEnvelope({ project: [suggested] }),
      });

      const options = await optionsOf(card, "project");

      expect(orderOf(options, [current, suggested, busy, quiet, tied])).toEqual([
        current,
        suggested,
        busy,
        quiet,
        tied,
        null,
      ]);
      expect(options.find((option) => option.id === suggested)).toMatchObject({ suggested: true });
      expect(options.find((option) => option.id === current)).toMatchObject({ suggested: false });
      expect(options.find((option) => option.id === busy)).toMatchObject({ suggested: false });
    });

    it("puts the current value before another project the assistant suggested, though it is suggested too", async () => {
      const kept = await createProject("Zzz kept");
      const alsoSuggested = await createProject("Aaa also suggested");
      const card = await createCard({
        proposal: await taskEnvelope({ project: [kept] }),
        aiProposal: await taskEnvelope({ project: [kept, alsoSuggested] }),
      });

      const options = await optionsOf(card, "project");

      expect(orderOf(options, [kept, alsoSuggested])).toEqual([kept, alsoSuggested, null]);
      expect(options.find((option) => option.id === alsoSuggested)).toMatchObject({ suggested: true });
    });

    it("marks the current value as suggested when the assistant proposed the same project", async () => {
      const project = await createProject("Same");
      const card = await createCard({ proposal: await taskEnvelope({ project: [project] }) });

      const options = await optionsOf(card, "project");

      expect(options[0]).toMatchObject({ id: project, suggested: true });
    });

    it("orders by the number of edges of the card's own relation only", async () => {
      const viaTasks = await createProject("Zzz via tasks");
      const viaFiles = await createProject("Aaa via files");
      await linkTaskToProject(viaTasks);
      await linkFileToProject(viaFiles);
      await linkFileToProject(viaFiles);
      const card = await createCard({ proposal: await taskEnvelope() });

      expect(orderOf(await optionsOf(card, "project"), [viaTasks, viaFiles])).toEqual([viaTasks, viaFiles, null]);
    });

    it("orders the names of the locale: Chata sorts after Hora in Czech and before it in English", async () => {
      const names = ["Chata", "Hora"];
      const ids = await Promise.all(names.map((name) => createProject(name)));
      const card = await createCard({ proposal: await taskEnvelope() });
      const labelsOf = async (locale: string): Promise<string[]> =>
        (await optionsOf(card, "project", { locale }))
          .filter((option) => option.id !== null && ids.includes(option.id))
          .map((option) => option.label);

      const czech = await labelsOf("cs");
      const english = await labelsOf("en");

      expect(czech).toEqual([...names].sort((a: string, b: string) => new Intl.Collator("cs").compare(a, b)));
      expect(english).toEqual([...names].sort((a: string, b: string) => new Intl.Collator("en").compare(a, b)));
      expect(czech).not.toEqual(english);
    });

    it("orders people by edges and gives them initials of the first and the last word, and no color", async () => {
      const [novak, plain] = await Promise.all([
        createItem("people", { name: "jan karel novák" }),
        createItem("people", { name: "Madonna" }),
      ]);
      await linkTaskToPerson(novak);
      const card = await createCard({ proposal: await taskEnvelope() });

      const options = await optionsOf(card, "people");

      expect(orderOf(options, [novak, plain])).toEqual([novak, plain]);
      expect(options.find((option) => option.id === novak)).toMatchObject({ label: "jan karel novák", initials: "JN" });
      expect(options.find((option) => option.id === plain)).toMatchObject({ initials: "M" });
      expect(options.find((option) => option.id === novak)).not.toHaveProperty("color");
      expect(options.some((option) => option.none)).toBe(false);
    });
  });

  describe("the none choice and the labels", () => {
    it("offers no area field", () => {
      expect(PROPOSAL_OPTION_FIELDS).toEqual(["project", "people", "company", "page", "mcpProjects"]);
      expect(isProposalOptionField("area")).toBe(false);
    });

    it("puts the none choice last for project and company, and none for the other fields", async () => {
      const card = await createCard({ proposal: await taskEnvelope() });
      await createProject("Home");
      await createItem("companies", { name: "Acme" });

      const projects = await optionsOf(card, "project");
      expect(projects.at(-1)).toMatchObject({ id: null, none: true });
      expect(projects.filter((option) => option.none)).toHaveLength(1);
      expect(projects[0]).toMatchObject({ label: "Home" });
      expect((await optionsOf(card, "company")).at(-1)).toMatchObject({ id: null, none: true });
      for (const field of ["people", "page", "mcpProjects"] as const) {
        expect(
          (await optionsOf(card, field)).some((option) => option.none),
          field,
        ).toBe(false);
      }
    });

    it("localizes the none label of each field with a none choice", async () => {
      const card = await createCard({ proposal: await taskEnvelope() });
      const noneLabel = async (field: ProposalOptionField, locale: string): Promise<string | undefined> =>
        (await optionsOf(card, field, { locale })).find((option) => option.none)?.label;

      expect(await noneLabel("project", "en")).toBe("No project");
      expect(await noneLabel("project", "cs")).toBe("Bez projektu");
      expect(await noneLabel("company", "en")).toBe("No company");
      expect(await noneLabel("company", "cs")).toBe("Bez firmy");
      expect(await noneLabel("project", "de")).toBe("No project");
    });

    it("returns the color of a project, and none for an item that has no color", async () => {
      const colored = await createProject("Colored", { color: "#3366FF" });
      const plain = await createProject("Plain");
      const company = await createItem("companies", { name: "Acme" });
      const card = await createCard({ proposal: await taskEnvelope() });

      const projects = await optionsOf(card, "project");
      const companies = await optionsOf(card, "company");

      expect(projects.find((option) => option.id === colored)).toMatchObject({ color: "#3366FF" });
      expect(projects.find((option) => option.id === plain)).not.toHaveProperty("color");
      expect(companies.find((option) => option.id === company)).not.toHaveProperty("color");
    });
  });

  describe("a step that would create the item", () => {
    const steps = (company: Record<string, unknown>, relations?: Record<string, Array<string | { ref: string }>>) => [
      { ref: "task", op: "create", databaseKey: "tasks", role: "primary", properties: { name: "Task" }, relations },
      {
        ref: "newCompany",
        op: "create",
        databaseKey: "companies",
        role: "secondary",
        properties: { name: "Fresh Co" },
        ...company,
      },
    ];

    const stepEnvelope = async (
      company: Record<string, unknown>,
      relations?: Record<string, Array<string | { ref: string }>>,
    ): Promise<Record<string, unknown>> => ({
      entityKind: "database",
      target: await inA((client) => databaseId(client, "tasks")),
      properties: { name: "Task" },
      operations: steps(company, relations),
    });

    it("lists a new company with its ref, suggested, and the localized hint", async () => {
      const existing = await createItem("companies", { name: "Existing Co" });
      const card = await createCard({ proposal: await stepEnvelope({}) });

      const english = await optionsOf(card, "company");
      const czech = await optionsOf(card, "company", { locale: "cs" });

      expect(english.find((option) => option.ref === "newCompany")).toEqual({
        id: null,
        ref: "newCompany",
        label: "Fresh Co",
        disabled: false,
        hint: "New - will be created",
        suggested: true,
      });
      expect(czech.find((option) => option.ref === "newCompany")?.hint).toBe("Nový - bude vytvořen");
      expect(orderOf(english, [existing]).at(-1)).toBeNull();
      expect(english.map((option) => option.id)).toContain(existing);
    });

    it("lists a new company before the other companies, and first when the primary step links to it", async () => {
      const existing = await createItem("companies", { name: "Zzz Co" });
      const suggestedExisting = await createItem("companies", { name: "Aaa Co" });
      const unlinked = await createCard({
        proposal: await stepEnvelope({}),
        aiProposal: await stepEnvelope({}),
      });
      const linked = await createCard({
        proposal: await stepEnvelope({}, { company: [{ ref: "newCompany" }] }),
        aiProposal: { ...(await stepEnvelope({}, { company: [suggestedExisting] })) },
      });

      const unlinkedOptions = await optionsOf(unlinked, "company");
      const linkedOptions = await optionsOf(linked, "company");

      expect(unlinkedOptions.map((option) => option.ref ?? option.id).slice(0, 1)).toEqual(["newCompany"]);
      expect(linkedOptions.map((option) => option.ref ?? option.id).slice(0, 2)).toEqual([
        "newCompany",
        suggestedExisting,
      ]);
      expect(linkedOptions.map((option) => option.id)).toContain(existing);
    });

    it("does not list a switched-off step, a step that creates another kind of item, or the primary step", async () => {
      const envelope = await stepEnvelope({ enabled: false });
      const card = await createCard({ proposal: envelope });
      const taskCard = await createCard({ proposal: await stepEnvelope({}) });

      expect((await optionsOf(card, "company")).some((option) => option.ref !== undefined)).toBe(false);
      expect((await optionsOf(taskCard, "project")).some((option) => option.ref !== undefined)).toBe(false);
      expect((await optionsOf(taskCard, "company")).filter((option) => option.ref !== undefined)).toHaveLength(1);
    });

    it("labels a step without a name by its ref", async () => {
      const card = await createCard({ proposal: await stepEnvelope({ properties: {} }) });

      expect((await optionsOf(card, "company")).find((option) => option.ref === "newCompany")?.label).toBe(
        "newCompany",
      );
    });
  });

  describe("the other fields", () => {
    it("reads the value of the company field from the user's manual value, and of an mcp card from its list of projects", async () => {
      const acme = await createItem("companies", { name: "Zzz company" });
      await createItem("companies", { name: "Aaa company" });
      const projectA = await createProject("Zzz project");
      await createProject("Aaa project");
      const companyCard = await createCard({
        proposal: await taskEnvelope(),
        userOverrides: { primary: { company: acme } },
      });
      const mcpCard = await createCard({
        proposal: {
          entityKind: "database",
          target: await inA((c) => databaseId(c, "tasks")),
          properties: { mcpProjects: [projectA] },
        },
      });

      const companies = await optionsOf(companyCard, "company");
      const mcp = await optionsOf(mcpCard, "mcpProjects");

      expect(companies[0]).toMatchObject({ id: acme });
      expect(companies.at(-1)).toMatchObject({ id: null, none: true });
      expect(mcp[0]).toMatchObject({ id: projectA });
      expect(mcp.some((option) => option.none)).toBe(false);
    });

    it("lists every live project for mcpProjects, archived and done ones under the rules of the project field", async () => {
      const live = await createProject("Live");
      const archived = await createProject("Archived");
      const done = await createProject("Done");
      await setStatus("projects", archived, "archived");
      await setStatus("projects", done, "done");
      const card = await createCard({ proposal: await taskEnvelope() });

      const ids = (await optionsOf(card, "mcpProjects")).map((option) => option.id);
      const withDone = (await optionsOf(card, "mcpProjects", { includeDone: true })).map((option) => option.id);

      expect(ids).toContain(live);
      expect(ids).not.toContain(archived);
      expect(ids).not.toContain(done);
      expect(withDone).toContain(done);
    });

    it("lists projects and subpages for page, with the card's page first", async () => {
      const project = await createProject("Zzz host");
      const otherProject = await createProject("Aaa project");
      const subpage = await inA(async (client) => {
        const created = await createSubpageWithClient(
          client,
          { parent: { itemId: project }, title: "Notes page" },
          "user",
        );
        return created.pages[0]!.pageItemId;
      });
      const trashedSubpage = await inA(async (client) => {
        const created = await createSubpageWithClient(
          client,
          { parent: { itemId: project }, title: "Gone page" },
          "user",
        );
        return created.pages[0]!.pageItemId;
      });
      await trash("pages", trashedSubpage);
      const card = await createCard({
        proposal: { entityKind: "pageContent", target: project, properties: { markdown: "Hello", placement: "end" } },
      });

      const options = await optionsOf(card, "page");

      expect(options[0]).toMatchObject({ id: project, label: "Zzz host" });
      expect(options.map((option) => option.id)).toEqual(expect.arrayContaining([otherProject, subpage]));
      expect(options.find((option) => option.id === subpage)).toMatchObject({ label: "Notes page", disabled: false });
      expect(options.map((option) => option.id)).not.toContain(trashedSubpage);
      expect(options.some((option) => option.none)).toBe(false);
    });
  });

  describe("an unknown card", () => {
    it("is a NotFoundError for a random id, a trashed card and a card of another tenant, in the same words", async () => {
      const card = await createCard({ proposal: await taskEnvelope() });
      const trashed = await createCard({ proposal: await taskEnvelope() });
      await inA(async (client) => {
        await itemDeleteWithClient(client, await databaseId(client, "processingProposals"), trashed, {
          queueAffinity: createActionQueueAffinity(),
        });
      });
      const foreignProject = await createProject("Tenant A only");
      const reason = async (cardId: string, tenant: string): Promise<string> => {
        const failure = await optionsOf(cardId, "project", { tenant }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(NotFoundError);
        return (failure as Error).message.replace(cardId, "<id>");
      };

      const forRandom = await reason("2b0d1c1e-5a0b-4a8a-9d1a-3f5f6a1b9c11", tenantA);
      expect(await reason(trashed, tenantA)).toBe(forRandom);
      expect(await reason(card, tenantB)).toBe(forRandom);
      // The same tenant still reads its own card, and the other tenant never sees the first tenant's project.
      expect((await optionsOf(card, "project")).map((option) => option.id)).toContain(foreignProject);
      const ownCardOfB = await createCard({ proposal: await taskEnvelope({}, tenantB) }, tenantB);
      expect((await optionsOf(ownCardOfB, "project", { tenant: tenantB })).map((option) => option.id)).not.toContain(
        foreignProject,
      );
    });
  });
});
