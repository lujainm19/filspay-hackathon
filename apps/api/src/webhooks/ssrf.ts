import { isIP } from "node:net";

/**
 * S18 helper: is this IP address somewhere a merchant's webhook must never
 * point us at? Covers loopback, private LAN ranges, link-local (including the
 * cloud metadata address 169.254.169.254), carrier-grade NAT, "this network",
 * multicast/reserved, and the IPv6 equivalents (plus IPv4-mapped IPv6).
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateIPv4(mapped[1] as string);
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") || // unique local fc00::/7
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") || // link-local fe80::/10
      lower.startsWith("ff") // multicast
    );
  }
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast and reserved
  );
}

/** Hostnames that always mean "this machine / this network". */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local");
}
