import dns, { type LookupAddress } from "node:dns";
import { isIP } from "node:net";

/**
 * Replaces `dns.lookup` so a test can make a hostname resolve to chosen addresses (issue #1034's
 * outbound address policy tests). Hostnames not in the table go to the real `dns.lookup`, because
 * other code in the process (the `pg` pool) resolves through the same function. A hostname mapped to
 * an empty list fails through the callback with `ENOTFOUND`, as the real resolver does for an unknown
 * name. Restore it in `afterEach`/`finally`.
 */
export interface DnsLookupStub {
  /** Every stubbed hostname looked up, in order. */
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

  // `defineProperty` rather than assignment: `dns.lookup` is overloaded, and this stub implements
  // the overloads by inspecting its arguments at runtime.
  Object.defineProperty(dns, "lookup", { value: stubbedLookup, configurable: true, writable: true });
  return {
    calls,
    restore: () => {
      Object.defineProperty(dns, "lookup", { value: original, configurable: true, writable: true });
    },
  };
}
