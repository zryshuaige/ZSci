"""Network safety helpers (design.md §16.3).

Used to prevent SSRF from the PDF-download endpoint: a client-controlled URL
must not resolve to private/loopback/link-local addresses.
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


class UrlSafetyError(ValueError):
    """Raised when a URL is rejected for SSRF safety reasons."""


def assert_safe_external_url(url: str, *, allow_schemes: tuple[str, ...] = ("http", "https")) -> str:
    """Validate `url` is safe to fetch server-side.

    - Scheme must be in `allow_schemes`.
    - Host must resolve to a PUBLIC IP (no loopback, private, link-local, etc.).
    - Rejects AWS/GCP metadata endpoints and common internal addresses.

    Raises `UrlSafetyError` if the URL is unsafe. Returns the normalized URL on
    success.
    """
    parsed = urlparse(url)
    if parsed.scheme not in allow_schemes:
        raise UrlSafetyError(
            f"URL scheme '{parsed.scheme}' not allowed (allowed: {allow_schemes})."
        )
    host = parsed.hostname
    if not host:
        raise UrlSafetyError("URL has no hostname.")
    # Reject obvious metadata hostnames up front.
    if host in ("metadata.google.internal", "metadata", "169.254.169.254"):
        raise UrlSafetyError("Metadata endpoint URLs are not allowed.")

    # Resolve and check every returned address.
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise UrlSafetyError(f"Cannot resolve host '{host}': {exc}") from exc
    for _family, _stype, _proto, _canon, sockaddr in infos:
        ip = sockaddr[0]
        # IPv6 addresses may carry scope/zones; strip them.
        if "%" in ip:
            ip = ip.split("%", 1)[0]
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError as exc:
            raise UrlSafetyError(f"Unparseable IP '{ip}' for host '{host}'.") from exc
        if (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_multicast
            or addr.is_reserved
            or addr.is_unspecified
        ):
            raise UrlSafetyError(
                f"Host '{host}' resolves to a non-public address {ip}; "
                "fetching internal IPs is blocked (SSRF protection)."
            )
    return url
