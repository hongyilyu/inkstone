//! Browser-Origin policy for the `/ws` handshake (ADR-0007, authenticated
//! remote ingress).

use axum::http::{HeaderMap, Uri, header};
use std::net::IpAddr;

/// Whether this handshake's `Origin` may open the WebSocket. `public_origin`
/// is the operator-configured remote origin (`INKSTONE_PUBLIC_ORIGIN`).
///
/// Accepted: no `Origin` at all (non-browser Clients don't send one), the
/// exact https `public_origin`, or a loopback http origin that matches the
/// request `Host` (direct local use and Vite dev). Every other present
/// `Origin` — malformed, opaque, lookalike, cross-site, or DNS-rebound — is
/// rejected; the caller answers 403 before upgrade.
pub fn allowed(headers: &HeaderMap, public_origin: Option<&str>) -> bool {
    let mut origins = headers.get_all(header::ORIGIN).iter();
    let Some(origin) = origins.next() else {
        return true;
    };
    if origins.next().is_some() {
        return false;
    }
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Ok(uri) = origin.parse::<Uri>() else {
        return false;
    };
    let (Some(scheme), Some(authority)) = (uri.scheme_str(), uri.authority()) else {
        return false;
    };
    // A browser Origin is exactly `scheme "://" authority` — reconstructing it
    // must reproduce the raw header, or a path/query/fragment rode along.
    // Userinfo needs its own check: `Uri` folds it into the authority, so it
    // survives the round-trip.
    if origin != format!("{scheme}://{authority}") || authority.as_str().contains('@') {
        return false;
    }

    match scheme {
        "https" => public_origin == Some(origin),
        "http" => {
            let Some(host) = headers
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
            else {
                return false;
            };
            authority.as_str().eq_ignore_ascii_case(host) && is_loopback_host(authority.host())
        }
        _ => false,
    }
}

/// `localhost` or a loopback IP literal, with IPv6 hosts unbracketed for
/// `IpAddr` parsing (`Authority::host` keeps the RFC 3986 brackets).
fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    bare.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const PUBLIC_ORIGIN: &str = "https://inkstone.example.com";

    fn headers(origin: Option<&str>, host: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(origin) = origin {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        if let Some(host) = host {
            headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        }
        headers
    }

    #[test]
    fn missing_origin_upgrades_regardless_of_config() {
        assert!(allowed(&headers(None, Some("127.0.0.1:8765")), None));
        assert!(allowed(
            &headers(None, Some("127.0.0.1:8765")),
            Some(PUBLIC_ORIGIN)
        ));
    }

    #[test]
    fn exact_public_origin_is_accepted() {
        assert!(allowed(
            &headers(Some(PUBLIC_ORIGIN), Some("127.0.0.1:8765")),
            Some(PUBLIC_ORIGIN)
        ));
    }

    #[test]
    fn public_origin_near_misses_are_rejected() {
        for near_miss in [
            "https://inkstone.example.com/",
            "https://inkstone.example.com/path",
            "https://Inkstone.Example.com",
            "https://inkstone.example.com:8443",
            "https://inkstone.example.com.evil.test",
            "http://inkstone.example.com",
        ] {
            assert!(
                !allowed(
                    &headers(Some(near_miss), Some("127.0.0.1:8765")),
                    Some(PUBLIC_ORIGIN)
                ),
                "{near_miss:?} must not match {PUBLIC_ORIGIN:?}"
            );
        }
    }

    #[test]
    fn https_origins_are_rejected_when_unconfigured() {
        assert!(!allowed(
            &headers(Some(PUBLIC_ORIGIN), Some("127.0.0.1:8765")),
            None
        ));
    }

    #[test]
    fn same_host_loopback_http_origins_are_accepted() {
        for (origin, host) in [
            ("http://localhost:5173", "localhost:5173"),
            ("http://127.0.0.1:8765", "127.0.0.1:8765"),
            ("http://[::1]:8765", "[::1]:8765"),
        ] {
            assert!(
                allowed(&headers(Some(origin), Some(host)), None),
                "loopback origin {origin:?} with matching Host upgrades"
            );
        }
    }

    #[test]
    fn agreeing_non_loopback_origin_and_host_are_rejected() {
        // DNS rebinding: both headers carry the attacker's domain (the
        // "trust Origin when it matches Host" policy ADR-0007 rejects).
        for (origin, host) in [
            ("http://evil.test", "evil.test"),
            ("http://evil.test:8765", "evil.test:8765"),
            (
                "http://localhost.evil.test:8765",
                "localhost.evil.test:8765",
            ),
            ("http://192.168.1.7:8765", "192.168.1.7:8765"),
        ] {
            assert!(
                !allowed(&headers(Some(origin), Some(host)), None),
                "rebound origin {origin:?} must be rejected"
            );
        }
    }

    #[test]
    fn loopback_origin_with_mismatched_host_is_rejected() {
        assert!(!allowed(
            &headers(Some("http://localhost:5173"), Some("127.0.0.1:8765")),
            None
        ));
        assert!(!allowed(
            &headers(Some("http://localhost:5173"), None),
            None
        ));
    }

    #[test]
    fn malformed_and_opaque_origins_are_rejected() {
        for origin in [
            "null",
            "not-an-origin",
            "chrome-extension://abcdef",
            "file://",
            "http://user@localhost:5173",
            "http://localhost:5173/path",
            "http://localhost:5173?q=1",
            "http://localhost:5173#f",
        ] {
            assert!(
                !allowed(&headers(Some(origin), Some("localhost:5173")), None),
                "origin {origin:?} must be rejected"
            );
        }
    }

    #[test]
    fn duplicate_origin_headers_are_rejected() {
        let mut duplicated = headers(Some("http://localhost:5173"), Some("localhost:5173"));
        duplicated.append(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:5173"),
        );
        assert!(!allowed(&duplicated, None));
    }

    #[test]
    fn non_utf8_origin_is_rejected() {
        let mut headers = headers(None, Some("localhost:5173"));
        headers.insert(header::ORIGIN, HeaderValue::from_bytes(&[0xff]).unwrap());
        assert!(!allowed(&headers, None));
    }
}
