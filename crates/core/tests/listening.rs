mod common;
use common::Workspace;

#[test]
fn core_announces_listening_url_and_serves_root() {
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    let response = reqwest::blocking::get(core.http_url()).expect("GET / succeeds");
    let status = response.status();
    let body = response.text().expect("body decodes");

    drop(core);

    assert_eq!(status.as_u16(), 200, "GET / returns 200");
    assert_eq!(body, "Inkstone Core", "GET / body matches");
}
