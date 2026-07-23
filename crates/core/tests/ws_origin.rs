//! Browser-origin policy at Core's public WebSocket handshake (ADR-0007).

mod common;

use common::{CoreHandle, Workspace, rt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::{HOST, ORIGIN};
use tokio_tungstenite::tungstenite::{Error, Result};

const PUBLIC_ORIGIN: &str = "https://inkstone.example.com";

async fn connect_with_origin_and_host(
    core: &CoreHandle,
    origin: Option<&str>,
    host: Option<&str>,
) -> Result<()> {
    let mut request = core
        .ws_url()
        .into_client_request()
        .expect("WebSocket request builds");
    if let Some(origin) = origin {
        request.headers_mut().insert(
            ORIGIN,
            HeaderValue::from_str(origin).expect("test Origin is a valid header value"),
        );
    }
    if let Some(host) = host {
        request.headers_mut().insert(
            HOST,
            HeaderValue::from_str(host).expect("test Host is a valid header value"),
        );
    }
    tokio_tungstenite::connect_async(request).await.map(|_| ())
}

async fn connect_with_origin(core: &CoreHandle, origin: Option<&str>) -> Result<()> {
    connect_with_origin_and_host(core, origin, None).await
}

fn assert_forbidden(result: Result<()>, origin: &str) {
    match result {
        Err(Error::Http(response)) => assert_eq!(
            response.status().as_u16(),
            403,
            "Origin {origin:?} is rejected before upgrade"
        ),
        Err(other) => panic!("Origin {origin:?} failed for the wrong reason: {other}"),
        Ok(()) => panic!("Origin {origin:?} unexpectedly upgraded"),
    }
}

#[test]
fn configured_public_origin_is_the_only_remote_browser_origin() {
    let workspace = Workspace::new();
    let core = workspace
        .core()
        .env("INKSTONE_PUBLIC_ORIGIN", PUBLIC_ORIGIN)
        .spawn();

    rt().block_on(async {
        connect_with_origin(&core, Some(PUBLIC_ORIGIN))
            .await
            .expect("the configured public origin upgrades");
        connect_with_origin(&core, None)
            .await
            .expect("a non-browser Client without Origin upgrades");
        connect_with_origin_and_host(&core, Some("http://localhost:5173"), Some("localhost:5173"))
            .await
            .expect("a same-host Vite development origin upgrades");
        // The embedded Web Client's shape: Origin is Core's own announced
        // http://127.0.0.1:<port>, Host derived from the connect URL matches.
        connect_with_origin(&core, Some(core.http_url()))
            .await
            .expect("the embedded web client's own-listener origin upgrades");

        for origin in [
            "https://other.example.com",
            "https://inkstone.example.com.evil.test",
            "not-an-origin",
            "null",
        ] {
            assert_forbidden(connect_with_origin(&core, Some(origin)).await, origin);
        }

        // DNS rebinding: Origin and Host agree on a non-loopback host — the
        // "trust Origin when it matches Host" policy ADR-0007 rejects.
        assert_forbidden(
            connect_with_origin_and_host(
                &core,
                Some("http://evil.test:8765"),
                Some("evil.test:8765"),
            )
            .await,
            "http://evil.test:8765",
        );
        // A loopback origin whose Host doesn't match (default Host is the
        // 127.0.0.1:<port> connect address) is rejected: same-host required.
        assert_forbidden(
            connect_with_origin(&core, Some("http://localhost:5173")).await,
            "http://localhost:5173",
        );
    });
}

#[test]
fn remote_browser_origins_fail_closed_when_unconfigured() {
    let workspace = Workspace::new();
    // Empty is unset (config contract) — pins "unconfigured" against any
    // ambient INKSTONE_PUBLIC_ORIGIN the spawned Core would inherit.
    let core = workspace.core().env("INKSTONE_PUBLIC_ORIGIN", "").spawn();

    rt().block_on(async {
        assert_forbidden(
            connect_with_origin(&core, Some(PUBLIC_ORIGIN)).await,
            PUBLIC_ORIGIN,
        );
    });
}

#[test]
fn configured_remote_http_origin_is_rejected() {
    const INSECURE_ORIGIN: &str = "http://inkstone.example.com";

    let workspace = Workspace::new();
    let core = workspace
        .core()
        .env("INKSTONE_PUBLIC_ORIGIN", INSECURE_ORIGIN)
        .spawn();

    rt().block_on(async {
        assert_forbidden(
            connect_with_origin(&core, Some(INSECURE_ORIGIN)).await,
            INSECURE_ORIGIN,
        );
    });
}
