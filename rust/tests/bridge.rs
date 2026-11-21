//! End-to-end check of the Rust client against the real Node sidecar.

use std::process::Command;

use serde_json::json;

use tiktokautouploader::bridge::{locate, Bridge};

fn node_is_available() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[test]
fn bridge_answers_ping_and_reports_unknown_methods() {
    if !node_is_available() {
        eprintln!("skipping: node is not on PATH");
        return;
    }

    if locate().is_err() {
        eprintln!("skipping: bridge/server.js was not found");
        return;
    }

    let mut bridge = Bridge::connect().expect("the bridge should start");

    assert_eq!(bridge.call("ping", json!({})).unwrap(), json!("pong"));

    let error = bridge.call("definitely-not-a-method", json!({})).unwrap_err();
    assert!(
        error.to_string().contains("unknown method"),
        "unexpected error: {error}"
    );

    bridge.call("close", json!({})).unwrap();
}
