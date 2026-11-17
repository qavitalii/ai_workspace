import { isIP } from "node:net";

/** Trust only the immediate, explicitly configured proxy; never an entire hop chain. */
export function proxyTrust(value: string) {
  const ips = value
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
  if (ips.some((ip) => !isIP(ip)))
    throw new Error("TRUSTED_PROXY_IPS must contain explicit IP addresses.");
  const normalize = (ip: string) => ip.replace(/^::ffff:/i, "").toLowerCase();
  const trusted = new Set(ips.map(normalize));
  return (address: string, hop: number) =>
    hop === 0 && trusted.has(normalize(address));
}
