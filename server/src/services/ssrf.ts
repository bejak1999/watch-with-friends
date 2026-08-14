import dns from 'dns';
import net from 'net';

/**
 * Guard for URLs the *server* is about to fetch on a user's behalf.
 *
 * Without this, any signed-in member could point the resolver at
 * http://192.168.1.1/ or http://169.254.169.254/ and use the server as a port
 * scanner for the network it sits on. Playback itself is unaffected: that
 * happens in the viewer's own browser, so LAN sources such as a Jellyfin box
 * still work - we simply refuse to reach out to them from here.
 */

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;

  if (a === 0) return true;                        // 0.0.0.0/8 "this network"
  if (a === 10) return true;                       // private
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;         // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;           // protocol assignments / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true;          // TEST-NET-2
  if (a === 203 && b === 0) return true;           // TEST-NET-3
  if (a >= 224) return true;                       // multicast + reserved + broadcast
  return false;
}

function ipv6IsPrivate(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];

  if (addr === '::' || addr === '::1') return true;
  // IPv4-mapped (::ffff:10.0.0.1) and NAT64 both wrap a v4 address.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || addr.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);

  const head = parseInt(addr.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function addressIsPrivate(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return ipv4IsPrivate(ip);
  if (version === 6) return ipv6IsPrivate(ip);
  return true; // not an IP at all - treat as unsafe
}

export interface SafetyVerdict {
  safe: boolean;
  reason?: string;
}

/**
 * Resolves the host and rejects anything that lands inside the local network.
 * DNS is consulted directly, so a name pointing at 127.0.0.1 is caught too.
 */
export async function isSafeToFetch(rawUrl: string): Promise<SafetyVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'not a valid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safe: false, reason: `unsupported scheme ${url.protocol}` };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // A literal address needs no lookup.
  if (net.isIP(host)) {
    return addressIsPrivate(host)
      ? { safe: false, reason: 'address is on a private or reserved network' }
      : { safe: true };
  }

  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(host)) {
    return { safe: false, reason: 'hostname resolves to the local network' };
  }

  let records: dns.LookupAddress[];
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    return { safe: false, reason: 'hostname could not be resolved' };
  }
  if (records.length === 0) return { safe: false, reason: 'hostname could not be resolved' };

  // Every answer must be public; one private record is enough to refuse.
  for (const record of records) {
    if (addressIsPrivate(record.address)) {
      return { safe: false, reason: 'hostname resolves to a private or reserved address' };
    }
  }
  return { safe: true };
}
