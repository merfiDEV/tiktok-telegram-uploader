//! Rust layer for `tiktokautouploader`.
//!
//! Split of responsibility:
//!
//! - **Rust (this crate)** — the flow itself: cookie lifecycle and expiry,
//!   schedule normalization/validation, retries, logging, the CLI, and the
//!   `upload_tiktok` entry point.
//! - **Node (`bridge/server.js`)** — the browser. It keeps
//!   `playwright-extra` + `puppeteer-extra-plugin-stealth`, the evasions that
//!   make the session look human, and exposes each DOM step as an RPC method.
//!
//! The split exists so the migration gains Rust where it pays off without
//! giving up the stealth layer, which has no Rust equivalent.

pub mod bridge;
pub mod cookies;
pub mod error;
pub mod upload;

pub use cookies::{check_expiry, cookie_file, read_cookies};
pub use error::UploadError;
pub use upload::{upload_tiktok, Proxy, UploadOptions, CONTENT_URL, DRAFT_URL, UPLOAD_URL};
