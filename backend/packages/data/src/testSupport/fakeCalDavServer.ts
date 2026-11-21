// An in-process CalDAV server on 127.0.0.1 for the CalDAV adapter's tests: Basic authentication, a well-known
// redirect, principal and calendar-home discovery, calendar listing, a calendar's members by PROPFIND, sync-collection
// (switchable), calendar-query, calendar-multiget and conditional PUT and DELETE. It answers only what the adapter asks,
// in the XML real servers send. `behaveLikePurelymail()` switches it to the quirks of Purelymail's server.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeCalDavCalendar {
  displayName: string | null;
  color: string | null;
  /** `read`, `write`, `write-content`, `all`, … as listed in `current-user-privilege-set`. */
  privileges: string[];
  components: string[];
}

interface StoredCalendar extends FakeCalDavCalendar {
  resources: Map<string, { text: string; etag: string }>;
  /** Change log for sync tokens: the version after each change and the resource it touched. */
  changes: Array<{ version: number; file: string }>;
  version: number;
  /** Part of every token; a token of an earlier epoch is refused as invalid. */
  tokenEpoch: number;
}

export interface FakeCalDavRequest {
  method: string;
  path: string;
  /** Which REPORT, for a REPORT. */
  report: string | null;
  /** The resources a calendar-multiget asked for. */
  hrefs: string[];
}

const PRINCIPAL_PATH = "/principals/owner/";
const HOME_PATH = "/calendars/owner/";

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function multistatus(responses: string[], extra = ""): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ca="http://apple.com/ns/ical/">
${responses.join("\n")}${extra}
</d:multistatus>`;
}

function okResponse(href: string, props: string): string {
  return `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function statusResponse(href: string, status: string): string {
  return `<d:response><d:href>${xmlEscape(href)}</d:href><d:status>HTTP/1.1 ${status}</d:status></d:response>`;
}

function hrefsOf(body: string): string[] {
  return [...body.matchAll(/<(?:\w+:)?href>([^<]*)<\/(?:\w+:)?href>/g)].map((match) => match[1] ?? "");
}

export class FakeCalDavServer {
  readonly requests: FakeCalDavRequest[] = [];
  /** Paths answered with a redirect to the given location instead. */
  readonly redirects = new Map<string, string>();
  syncCollectionSupported = true;
  /** `false`: no `getctag`, answered as a property the collection does not have. */
  ctagSupported = true;
  /**
   * `false`: no `sync-token` property; sync-collection answers only an empty token, listing every resource with no
   * token to continue from, and refuses any other.
   */
  syncTokensSupported = true;
  /** `true`: a calendar-query whose VEVENT comp-filter has no time-range answers an empty multistatus. */
  eventFilterNeedsTimeRange = false;
  /** Answers the next PUT or DELETE with 412, as a server whose resource changed after the client read it. */
  refuseNextWrite = false;
  private readonly calendars = new Map<string, StoredCalendar>();
  private etagCounter = 0;
  private server: Server | null = null;
  private port = 0;

  constructor(
    private readonly login: { username: string; password: string },
    /** Where `/.well-known/caldav` redirects; `null` answers it like the root. */
    private readonly wellKnownTarget: string | null = "/",
  ) {}

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  calendarPath(name: string): string {
    return `${HOME_PATH}${name}/`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("The fake CalDAV server has no port");
    this.port = address.port;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  addCalendar(name: string, calendar: FakeCalDavCalendar): void {
    this.calendars.set(name, { ...calendar, resources: new Map(), changes: [], version: 0, tokenEpoch: 0 });
  }

  /** Purelymail as observed: no ctag, no sync-token, and an empty answer to a VEVENT filter without a time-range. */
  behaveLikePurelymail(): void {
    this.ctagSupported = false;
    this.syncTokensSupported = false;
    this.eventFilterNeedsTimeRange = true;
  }

  /** A change at the provider: stores the resource with a new ETag. */
  putResource(calendar: string, file: string, text: string): string {
    const stored = this.calendarOf(calendar);
    const etag = `"e${++this.etagCounter}"`;
    stored.resources.set(file, { text, etag });
    this.recordChange(stored, file);
    return etag;
  }

  deleteResource(calendar: string, file: string): void {
    const stored = this.calendarOf(calendar);
    stored.resources.delete(file);
    this.recordChange(stored, file);
  }

  resource(calendar: string, file: string): { text: string; etag: string } | undefined {
    return this.calendarOf(calendar).resources.get(file);
  }

  files(calendar: string): string[] {
    return [...this.calendarOf(calendar).resources.keys()];
  }

  /** Makes every sync token issued so far invalid, as a server that pruned its change log. */
  expireSyncTokens(calendar: string): void {
    const stored = this.calendarOf(calendar);
    stored.tokenEpoch += 1;
  }

  private takeRefusal(): boolean {
    const refuse = this.refuseNextWrite;
    this.refuseNextWrite = false;
    return refuse;
  }

  private recordChange(stored: StoredCalendar, file: string): void {
    stored.version += 1;
    stored.changes.push({ version: stored.version, file });
  }

  private calendarOf(name: string): StoredCalendar {
    const stored = this.calendars.get(name);
    if (!stored) throw new Error(`The fake CalDAV server has no calendar ${name}`);
    return stored;
  }

  private syncToken(stored: StoredCalendar): string {
    return `${this.origin}/sync/${stored.tokenEpoch}/${stored.version}`;
  }

  private authorized(req: IncomingMessage): boolean {
    const expected = Buffer.from(`${this.login.username}:${this.login.password}`, "utf8").toString("base64");
    return req.headers.authorization === `Basic ${expected}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const body = Buffer.concat(chunks).toString("utf8");
    const method = req.method ?? "GET";
    const path = decodeURIComponent(new URL(req.url ?? "/", this.origin).pathname);
    const report =
      method === "REPORT" ? (/<(?:\w+:)?([a-z-]+)[\s>]/.exec(body.replace(/<\?xml[^>]*\?>/, ""))?.[1] ?? null) : null;
    this.requests.push({ method, path, report, hrefs: report === "calendar-multiget" ? hrefsOf(body) : [] });

    const redirect = this.redirects.get(path);
    if (redirect !== undefined) return this.send(res, 302, "", { Location: redirect });
    if (path === "/.well-known/caldav" && this.wellKnownTarget !== null) {
      return this.send(res, 301, "", { Location: this.wellKnownTarget });
    }
    if (!this.authorized(req)) return this.send(res, 401, "", { "WWW-Authenticate": 'Basic realm="fake"' });

    if (method === "PROPFIND") return this.propfind(res, path, req.headers.depth);
    if (method === "REPORT") return this.report(res, path, report, body);
    if (method === "GET") return this.get(res, path);
    if (method === "PUT") return this.put(req, res, path, body);
    if (method === "DELETE") return this.delete(req, res, path);
    return this.send(res, 405, "");
  }

  private send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { ...(body ? { "Content-Type": "application/xml; charset=utf-8" } : {}), ...headers });
    res.end(body);
  }

  private locate(path: string): { name: string; stored: StoredCalendar; file: string | null } | null {
    if (!path.startsWith(HOME_PATH)) return null;
    const [name = "", file = ""] = path.slice(HOME_PATH.length).split("/");
    const stored = this.calendars.get(name);
    return stored ? { name, stored, file: file === "" ? null : file } : null;
  }

  private calendarProps(stored: StoredCalendar): string {
    const privileges = stored.privileges.map((privilege) => `<d:privilege><d:${privilege}/></d:privilege>`).join("");
    const components = stored.components.map((component) => `<c:comp name="${component}"/>`).join("");
    return [
      "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>",
      stored.displayName === null ? "" : `<d:displayname>${xmlEscape(stored.displayName)}</d:displayname>`,
      stored.color === null ? "" : `<ca:calendar-color>${stored.color}</ca:calendar-color>`,
      this.ctagSupported ? `<cs:getctag>ctag-${stored.version}</cs:getctag>` : "",
      `<d:current-user-privilege-set>${privileges}</d:current-user-privilege-set>`,
      `<c:supported-calendar-component-set>${components}</c:supported-calendar-component-set>`,
      this.syncCollectionSupported && this.syncTokensSupported
        ? `<d:sync-token>${xmlEscape(this.syncToken(stored))}</d:sync-token>`
        : "",
    ].join("");
  }

  /** The calendar's properties with the 404 propstat a server adds for the version properties it does not have. */
  private calendarResponse(path: string, stored: StoredCalendar): string {
    const missing = [
      this.ctagSupported ? "" : "<cs:getctag/>",
      this.syncCollectionSupported && this.syncTokensSupported ? "" : "<d:sync-token/>",
    ].join("");
    const ok = okResponse(path, this.calendarProps(stored));
    if (missing === "") return ok;
    return ok.replace(
      "</d:response>",
      `<d:propstat><d:prop>${missing}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`,
    );
  }

  private propfind(res: ServerResponse, path: string, depth: string | string[] | undefined): void {
    if (path === "/" || path === "/.well-known/caldav") {
      return this.send(
        res,
        207,
        multistatus([
          okResponse(path, `<d:current-user-principal><d:href>${PRINCIPAL_PATH}</d:href></d:current-user-principal>`),
        ]),
      );
    }
    if (path === PRINCIPAL_PATH) {
      return this.send(
        res,
        207,
        multistatus([
          okResponse(path, `<c:calendar-home-set><d:href>${this.origin}${HOME_PATH}</d:href></c:calendar-home-set>`),
        ]),
      );
    }
    if (path === HOME_PATH) {
      const responses = [okResponse(HOME_PATH, "<d:resourcetype><d:collection/></d:resourcetype>")];
      if (depth === "1") {
        for (const [name, stored] of this.calendars) {
          responses.push(this.calendarResponse(this.calendarPath(name), stored));
        }
        responses.push(
          okResponse(`${HOME_PATH}inbox/`, "<d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype>"),
        );
      }
      return this.send(res, 207, multistatus(responses));
    }
    const located = this.locate(path);
    if (located === null || located.file !== null) return this.send(res, 404, "");
    const responses = [this.calendarResponse(path, located.stored)];
    if (depth === "1") {
      for (const [file, resource] of located.stored.resources) {
        responses.push(
          okResponse(`${path}${file}`, `<d:resourcetype/><d:getetag>${xmlEscape(resource.etag)}</d:getetag>`),
        );
      }
    }
    return this.send(res, 207, multistatus(responses));
  }

  private report(res: ServerResponse, path: string, report: string | null, body: string): void {
    const located = this.locate(path);
    if (located === null) return this.send(res, 404, "");
    const { stored, name } = located;
    const resourceHref = (file: string): string => `${this.calendarPath(name)}${file}`;
    if (report === "sync-collection") {
      if (!this.syncCollectionSupported) return this.send(res, 501, "");
      const token = /<(?:\w+:)?sync-token>([^<]*)</.exec(body)?.[1] ?? "";
      if (!this.syncTokensSupported) {
        if (token !== "") {
          return this.send(
            res,
            403,
            `<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>`,
          );
        }
        const all = [...stored.resources].map(([file, resource]) =>
          okResponse(resourceHref(file), `<d:getetag>${xmlEscape(resource.etag)}</d:getetag>`),
        );
        return this.send(res, 207, multistatus(all));
      }
      const [, epoch, version] = /\/sync\/(\d+)\/(\d+)$/.exec(token) ?? [];
      const since = Number(version ?? Number.NaN);
      if (Number(epoch) !== stored.tokenEpoch || !Number.isInteger(since) || since > stored.version) {
        return this.send(
          res,
          403,
          `<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>`,
        );
      }
      const touched = new Set(stored.changes.filter((change) => change.version > since).map((change) => change.file));
      const responses = [...touched].map((file) => {
        const resource = stored.resources.get(file);
        return resource === undefined
          ? statusResponse(resourceHref(file), "404 Not Found")
          : okResponse(resourceHref(file), `<d:getetag>${xmlEscape(resource.etag)}</d:getetag>`);
      });
      return this.send(
        res,
        207,
        multistatus(responses, `\n<d:sync-token>${xmlEscape(this.syncToken(stored))}</d:sync-token>`),
      );
    }
    if (report === "calendar-query") {
      const eventFilter = /<(?:\w+:)?comp-filter name="VEVENT"/.test(body);
      if (eventFilter && this.eventFilterNeedsTimeRange && !/<(?:\w+:)?time-range/.test(body)) {
        return this.send(res, 207, multistatus([]));
      }
      const responses = [...stored.resources]
        .filter(([, resource]) => !eventFilter || resource.text.includes("BEGIN:VEVENT"))
        .map(([file, resource]) =>
          okResponse(resourceHref(file), `<d:getetag>${xmlEscape(resource.etag)}</d:getetag>`),
        );
      return this.send(res, 207, multistatus(responses));
    }
    if (report === "calendar-multiget") {
      const responses = hrefsOf(body).map((href) => {
        const file = decodeURIComponent(href).split("/").pop() ?? "";
        const resource = stored.resources.get(file);
        return resource === undefined
          ? statusResponse(href, "404 Not Found")
          : okResponse(
              href,
              `<d:getetag>${xmlEscape(resource.etag)}</d:getetag><c:calendar-data>${xmlEscape(resource.text)}</c:calendar-data>`,
            );
      });
      return this.send(res, 207, multistatus(responses));
    }
    return this.send(res, 400, "");
  }

  private get(res: ServerResponse, path: string): void {
    const located = this.locate(path);
    const resource = located?.file ? located.stored.resources.get(located.file) : undefined;
    if (resource === undefined) return this.send(res, 404, "");
    res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", ETag: resource.etag });
    res.end(resource.text);
  }

  private put(req: IncomingMessage, res: ServerResponse, path: string, body: string): void {
    const located = this.locate(path);
    if (located === null || located.file === null) return this.send(res, 404, "");
    const existing = located.stored.resources.get(located.file);
    const ifMatch = req.headers["if-match"];
    if (this.takeRefusal()) return this.send(res, 412, "");
    if (req.headers["if-none-match"] === "*" && existing !== undefined) return this.send(res, 412, "");
    if (ifMatch !== undefined && ifMatch !== existing?.etag) return this.send(res, 412, "");
    const etag = this.putResource(located.name, located.file, body);
    return this.send(res, existing === undefined ? 201 : 204, "", { ETag: etag });
  }

  private delete(req: IncomingMessage, res: ServerResponse, path: string): void {
    const located = this.locate(path);
    if (located === null || located.file === null) return this.send(res, 404, "");
    const existing = located.stored.resources.get(located.file);
    if (existing === undefined) return this.send(res, 404, "");
    const ifMatch = req.headers["if-match"];
    if (this.takeRefusal()) return this.send(res, 412, "");
    if (ifMatch !== undefined && ifMatch !== existing.etag) return this.send(res, 412, "");
    this.deleteResource(located.name, located.file);
    return this.send(res, 204, "");
  }
}
