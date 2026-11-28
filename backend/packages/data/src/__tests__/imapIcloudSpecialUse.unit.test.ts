import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlowMailClient } from "../mail/imapFlowClient.js";
import { ICLOUD_IMAP_HOST, imapListOptions } from "../mail/imapSpecialUseHints.js";
import { FakeImapServer } from "../testSupport/fakeImapServer.js";

/**
 * An iCloud account as its server lists it: no SPECIAL-USE capability, only Sent and Trash flagged, and user folders
 * whose names imapflow also takes for an archive ("Archiv") or a junk folder ("Folders/Spam", "Spam") and that sort
 * before iCloud's own "Archive" and "Junk".
 */
const ICLOUD_FOLDERS = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: "Sent Messages", specialUse: "\\Sent" },
  { path: "Deleted Messages", specialUse: "\\Trash" },
  { path: "Drafts" },
  { path: "Junk" },
  { path: "Archive" },
  { path: "Archiv" },
  { path: "Folders/Spam" },
  { path: "Spam" },
  { path: "Projects" },
];

const servers: FakeImapServer[] = [];
const flows: ImapFlow[] = [];

afterEach(async () => {
  await Promise.all(flows.splice(0).map((flow) => flow.logout().catch(() => flow.close())));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function listedPurposes(host: string, folders = ICLOUD_FOLDERS): Promise<Record<string, string>> {
  const server = new FakeImapServer({ folders, capabilities: ["MOVE", "UIDPLUS"], latencyMs: 0 });
  servers.push(server);
  const port = await server.listen();
  const flow = new ImapFlow({
    host: "127.0.0.1",
    port,
    secure: false,
    auth: { user: "owner@example.test", pass: "app-password" },
    logger: false,
  });
  flow.on("error", () => {});
  flows.push(flow);
  await flow.connect();
  const listed = await new ImapFlowMailClient(flow, imapListOptions(host)).listFolders();
  return Object.fromEntries(listed.flatMap((folder) => (folder.specialUse ? [[folder.path, folder.specialUse]] : [])));
}

describe("special-use folders of an iCloud account", () => {
  it("are iCloud's own folders, not the user folders whose names sort first", async () => {
    expect(await listedPurposes(ICLOUD_IMAP_HOST)).toEqual({
      INBOX: "\\Inbox",
      "Sent Messages": "\\Sent",
      "Deleted Messages": "\\Trash",
      Drafts: "\\Drafts",
      Junk: "\\Junk",
      Archive: "\\Archive",
    });
  });

  it("fall back to a name match when the account lacks iCloud's folder", async () => {
    const withoutArchive = ICLOUD_FOLDERS.filter((folder) => folder.path !== "Archive");
    expect((await listedPurposes(ICLOUD_IMAP_HOST, withoutArchive))["Archiv"]).toBe("\\Archive");
  });

  it("are left to the name match on any other server", async () => {
    const purposes = await listedPurposes("imap.example.test");
    expect(purposes["Archiv"]).toBe("\\Archive");
    expect(purposes["Archive"]).toBeUndefined();
  });
});
