//! Client for the Node sidecar that owns the stealth browser.
//!
//! The browser engine (`playwright-extra` + `puppeteer-extra-plugin-stealth`)
//! has no Rust equivalent: those evasions are what keep TikTok from flagging
//! the session. Rather than reimplementing a weaker browser driver in Rust and
//! losing that, the browser stays in `bridge/server.js` and Rust drives it over
//! newline-delimited JSON on stdin/stdout.

use std::env;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

/// A running bridge process. Dropping it stops the sidecar.
pub struct Bridge {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Bridge {
    /// Start `node <script>`. The bridge's stderr is inherited, so the library's
    /// progress messages reach the user unchanged.
    pub fn spawn(script: &Path) -> Result<Self> {
        let mut child = Command::new("node")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| anyhow!("could not start node ({}): {error}", script.display()))?;

        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        })
    }

    /// Start the bridge found by [`locate`].
    pub fn connect() -> Result<Self> {
        Self::spawn(&locate()?)
    }

    /// Send one request and wait for its reply.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;

        let request = json!({ "id": id, "method": method, "params": params });
        writeln!(self.stdin, "{request}")?;
        self.stdin.flush()?;

        let mut line = String::new();
        if self.stdout.read_line(&mut line)? == 0 {
            bail!("the bridge closed before answering '{method}'");
        }

        let reply: Value = serde_json::from_str(line.trim())
            .map_err(|error| anyhow!("the bridge sent invalid JSON for '{method}': {error}"))?;

        if reply.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(reply.get("result").cloned().unwrap_or(Value::Null))
        } else {
            let name = reply["error"]["name"].as_str().unwrap_or("Error");
            let message = reply["error"]["message"].as_str().unwrap_or("bridge error");
            Err(anyhow!("{name}: {message}"))
        }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // The sidecar is a child of this process; make sure it does not outlive us.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Find `bridge/server.js`.
///
/// Order: `TIKTOK_BRIDGE`, the working directory, then paths relative to the
/// executable (so the binary also works from `target/release`).
pub fn locate() -> Result<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(from_env) = env::var_os("TIKTOK_BRIDGE") {
        candidates.push(PathBuf::from(from_env));
    }

    candidates.push(PathBuf::from("bridge/server.js"));
    candidates.push(PathBuf::from("../bridge/server.js"));

    if let Ok(exe) = env::current_exe() {
        for ancestor in exe.ancestors().skip(1).take(4) {
            candidates.push(ancestor.join("bridge/server.js"));
        }
    }

    if let Some(found) = candidates.iter().find(|path| path.is_file()) {
        return Ok(found.clone());
    }

    bail!(
        "could not find bridge/server.js; set TIKTOK_BRIDGE to its path (looked in: {})",
        candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    )
}
