#!/usr/bin/env python3
"""Validate a server host and print TLS name, URL host, and Caddy config name."""

import ipaddress
import re
import sys


def server_address(value):
    host = value.strip().lower()
    # Accept the bracket notation people copy from an IPv6 URL, but no ports.
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
        if ":" not in host:
            raise ValueError("Only IPv6 addresses may use brackets.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        labels = host.split(".")
        if (
            len(host) > 253
            or len(labels) < 2
            or not re.fullmatch(r"[a-z]{2,}|xn--[a-z0-9-]+", labels[-1])
            or any(
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in labels
            )
            or host.endswith((".localhost", ".local", ".internal", ".home.arpa"))
        ):
            raise ValueError(
                "Enter a domain or public IP address, without https://, a port or a path."
            ) from None
        return host, host, "Caddyfile"

    if (
        not address.is_global
        or address.is_multicast
        or address.is_reserved
        or "%" in host
        or (address.version == 6 and address.ipv4_mapped is not None)
    ):
        raise ValueError(
            "HTTPS requires a public IP assigned to this server; private, local and "
            "reserved addresses are not supported. Use --local for local access."
        )
    host = str(address)
    return host, f"[{host}]" if address.version == 6 else host, "Caddyfile.ip"


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Usage: server-address.py DOMAIN_OR_PUBLIC_IP")
        print(*server_address(sys.argv[1]))
    except ValueError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
