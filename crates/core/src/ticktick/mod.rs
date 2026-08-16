//! TickTick connection state (external-task-views A5/A7): Core owns the
//! TickTick credential for both read lanes (Web → OpenAPI in S2; Worker → MCP
//! via the spawn manifest). The endpoint is a compile-time constant with a
//! test-only override; there is no task-source config file.

pub mod client;
pub(crate) mod token;
mod wire;

pub use token::{connection, init};

/// TickTick's official MCP service (streamable HTTP).
const MCP_ENDPOINT: &str = "https://mcp.ticktick.com/";

/// The MCP endpoint Core ships in the spawn manifest — with the bearer token
/// beside it, sent as `Authorization: Bearer` to this URL by the Worker. The
/// `INKSTONE_TICKTICK_MCP_URL` override exists ONLY to point the fake-MCP
/// fixture at a local server, so it is honored ONLY for a loopback host: a
/// stray/hostile env var can never redirect the real credential to an
/// arbitrary origin. A non-loopback override is logged and ignored (falls back
/// to the const), making the "test-only" contract code shape, not prose.
pub fn mcp_endpoint() -> String {
    guarded_override(
        crate::config::get().ticktick_mcp_url_override.clone(),
        MCP_ENDPOINT,
        "ticktick.mcp_url_override_rejected",
    )
}

/// Resolve a token-bearing endpoint override to a concrete URL (A5/A7): an
/// override is honored ONLY for a loopback host, so a stray/hostile env var can
/// never redirect the real credential to an arbitrary origin. A non-loopback
/// override is logged under `event` and ignored — `fallback` stands. The ONE
/// place the loopback guard lives; both lanes (MCP here, OpenAPI base in
/// `client`) route through it.
pub(super) fn guarded_override(
    override_url: Option<String>,
    fallback: &str,
    event: &'static str,
) -> String {
    let Some(override_url) = override_url else {
        return fallback.to_string();
    };
    if is_loopback_url(&override_url) {
        return override_url;
    }
    tracing::warn!(event = event, reason = "non-loopback host");
    fallback.to_string()
}

/// Whether `url` targets a loopback host (127.0.0.0/8, ::1, or `localhost`) —
/// the only hosts a token may be sent to via a test-only override. Shared by
/// both lane overrides (MCP endpoint here, OpenAPI base in `client`).
pub(super) fn is_loopback_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(host)) => host == "localhost",
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_endpoint_override_is_loopback_only() {
        // Loopback overrides (the fake-MCP fixture) are honored.
        for url in [
            "http://127.0.0.1:9/mcp",
            "http://localhost:52100/mcp",
            "http://[::1]:9/mcp",
        ] {
            let _guard = crate::config::test_override::install(crate::config::Config {
                ticktick_mcp_url_override: Some(url.to_string()),
                ..Default::default()
            });
            assert_eq!(mcp_endpoint(), url, "loopback override {url} is honored");
        }

        // A non-loopback override is ignored — the token never leaves for it.
        for url in [
            "https://evil.example.com/mcp",
            "http://169.254.169.254/mcp",
            "not a url",
        ] {
            let _guard = crate::config::test_override::install(crate::config::Config {
                ticktick_mcp_url_override: Some(url.to_string()),
                ..Default::default()
            });
            assert_eq!(
                mcp_endpoint(),
                MCP_ENDPOINT,
                "non-loopback override {url} falls back to the const"
            );
        }
    }
}
