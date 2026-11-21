//! CLI, the Rust equivalent of `upload.js`.
//!
//!     tiktok-upload ./video.mp4 "Description" main viral test

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;

use tiktokautouploader::{upload_tiktok, Proxy, UploadOptions};

#[derive(Parser, Debug)]
#[command(
    name = "tiktok-upload",
    about = "Upload a video to TikTok",
    long_about = None
)]
struct Args {
    /// Path to the video file.
    video: String,

    /// Caption text (hashtags go in the trailing arguments).
    description: String,

    /// Account name; decides which TK_cookies_<account>.json is used.
    account: String,

    /// Hashtags, with or without a leading '#'.
    hashtags: Vec<String>,

    /// Show the browser window instead of running headless.
    #[arg(long)]
    headed: bool,

    /// Add extra delays on top of the always-on evasion.
    #[arg(long)]
    stealth: bool,

    /// Do not print progress messages.
    #[arg(long)]
    quiet: bool,

    /// `everyone`, `friends`, or `private`.
    #[arg(long, default_value = "everyone")]
    visibility: String,

    /// Sound to add, searched on the upload page.
    #[arg(long)]
    sound: Option<String>,

    /// `mix`, `main`, or `background`.
    #[arg(long, default_value = "mix")]
    sound_volume: String,

    /// `search` or `favorites`.
    #[arg(long, default_value = "search")]
    search_mode: String,

    /// Schedule time, 24h `HH:MM`; the minute must be a multiple of 5.
    #[arg(long)]
    schedule: Option<String>,

    /// Day of month to schedule on; requires --schedule.
    #[arg(long)]
    day: Option<String>,

    /// Run TikTok's copyright check before posting.
    #[arg(long)]
    copyright: bool,

    /// Select the last-frame cover.
    #[arg(long)]
    cover: Option<PathBuf>,

    /// Proxy server, e.g. http://host:port.
    #[arg(long)]
    proxy: Option<String>,

    #[arg(long, requires = "proxy")]
    proxy_user: Option<String>,

    #[arg(long, requires = "proxy")]
    proxy_pass: Option<String>,
}

fn main() -> ExitCode {
    let args = Args::parse();

    let proxy = args.proxy.map(|server| Proxy {
        server,
        username: args.proxy_user,
        password: args.proxy_pass,
    });

    let options = UploadOptions {
        cover_image: args.cover,
        hashtags: if args.hashtags.is_empty() {
            None
        } else {
            Some(args.hashtags)
        },
        sound_name: args.sound,
        sound_aud_vol: args.sound_volume,
        schedule: args.schedule,
        day: args.day,
        copyright_check: args.copyright,
        suppress_print: args.quiet,
        headless: !args.headed,
        stealth: args.stealth,
        proxy,
        search_mode: args.search_mode,
        visibility: args.visibility,
    };

    match upload_tiktok(&args.video, &args.description, &args.account, &options) {
        Ok(result) => {
            println!("Result: {result}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
