import dns, { type LookupAddress } from "node:dns";
import { isIP } from "node:net";

/**
 * Replaces `dns.lookup` so chosen hostnames resolve to chosen addresses. Others go to the real lookup, because the
 * `pg` pool resolves through it too. An empty list fails with `ENOTFOUND`. Restore in `afterEach`/`finally`.
 */
export interface DnsLookupStub {
  /** In lookup order. */
  readonly calls: string[];
  restore(): void;
}

type LookupAllCallback = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
type LookupOneCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

function wantsAll(options: unknown): boolean {
  return typeof options === "object" && options !== null && "all" in options && options.all === true;
}

export function stubDnsLookup(table: Readonly<Record<string, readonly string[]>>): DnsLookupStub {
  const original = dns.lookup;
  const calls: string[] = [];

  function stubbedLookup(hostname: string, ...rest: unknown[]): void {
    const addresses = table[hostname];
    if (addresses === undefined) {
      Reflect.apply(original, dns, [hostname, ...rest]);
      return;
    }
    calls.push(hostname);
    const options = rest.length > 1 ? rest[0] : undefined;
    const callback = rest[rest.length - 1];
    if (typeof callback !== "function") throw new TypeError("stubDnsLookup: lookup called without a callback");
    const entries = addresses.map((address) => ({ address, family: isIP(address) }));
    process.nextTick(() => {
      const first = entries[0];
      if (first === undefined) {
        const notFound: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        notFound.code = "ENOTFOUND";
        Reflect.apply(callback, undefined, [notFound, wantsAll(options) ? [] : "", 0]);
      } else if (wantsAll(options)) {
        Reflect.apply(callback, undefined, [null, entries] satisfies Parameters<LookupAllCallback>);
      } else {
        Reflect.apply(callback, undefined, [null, first.address, first.family] satisfies Parameters<LookupOneCallback>);
      }
    });
  }

  // `defineProperty`, not assignment: `dns.lookup` is overloaded and the stub dispatches on its arguments.
  Object.defineProperty(dns, "lookup", { value: stubbedLookup, configurable: true, writable: true });
  return {
    calls,
    restore: () => {
      Object.defineProperty(dns, "lookup", { value: original, configurable: true, writable: true });
    },
  };
}
