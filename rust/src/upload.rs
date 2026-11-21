//! The upload flow, orchestrated from Rust.
//!
//! One-to-one port of `uploadTiktok()` in `tiktokautouploader/function.js`. The
//! order of steps, the user-facing messages and the `'Completed'` / `'Error'`
//! return values are kept identical; only the DOM work happens on the other
//! side of the bridge.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::bridge::Bridge;
use crate::cookies::{check_expiry, cookie_file, read_cookies};
use crate::error::UploadError;

pub const UPLOAD_URL: &str =
    "https://www.tiktok.com/tiktokstudio/upload?from=upload&lang=en";
pub const DRAFT_URL: &str = "https://www.tiktok.com/tiktokstudio/content?tab=draft";
pub const CONTENT_URL: &str = "https://www.tiktok.com/tiktokstudio/content";

/// A proxy for the browser, in Playwright's shape.
#[derive(Debug, Clone, Default)]
pub struct Proxy {
    pub server: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl Proxy {
    fn to_json(&self) -> Value {
        let mut object = json!({ "server": self.server });
        if let Some(username) = &self.username {
            object["username"] = json!(username);
        }
        if let Some(password) = &self.password {
            object["password"] = json!(password);
        }
        object
    }
}

/// Every option `upload_tiktok` accepts, with the library's defaults.
#[derive(Debug, Clone)]
pub struct UploadOptions {
    /// Selecting a cover is enough to trigger the "last frame" cover flow.
    pub cover_image: Option<PathBuf>,
    pub hashtags: Option<Vec<String>>,
    pub sound_name: Option<String>,
    /// `mix` | `main` | `background`
    pub sound_aud_vol: String,
    /// `HH:MM`, 24h, minute must be a multiple of 5.
    pub schedule: Option<String>,
    /// Day of month; only meaningful together with `schedule`.
    pub day: Option<String>,
    pub copyright_check: bool,
    pub suppress_print: bool,
    pub headless: bool,
    /// Extra delays on top of the always-on evasion.
    pub stealth: bool,
    pub proxy: Option<Proxy>,
    /// `search` | `favorites`
    pub search_mode: String,
    pub visibility: String,
}

impl Default for UploadOptions {
    fn default() -> Self {
        Self {
            cover_image: None,
            hashtags: None,
            sound_name: None,
            sound_aud_vol: "mix".to_string(),
            schedule: None,
            day: None,
            copyright_check: false,
            suppress_print: false,
            headless: true,
            stealth: false,
            proxy: None,
            search_mode: "search".to_string(),
            visibility: "everyone".to_string(),
        }
    }
}

/// Normalize a request that passes the day via `schedule` and the time via
/// `day` (e.g. `schedule=25, day="12:05"`), as the JavaScript version does.
fn normalize_schedule_and_day(
    schedule: Option<String>,
    day: Option<String>,
) -> (Option<String>, Option<String>) {
    let swapped = match (&schedule, &day) {
        (Some(schedule), Some(day)) => {
            schedule.trim().parse::<i64>().is_ok() && day.contains(':')
        }
        _ => false,
    };

    if swapped {
        (day, schedule)
    } else {
        (schedule, day)
    }
}

fn validate_schedule_request(
    schedule: &Option<String>,
    day: &Option<String>,
) -> Result<(), UploadError> {
    if schedule.is_none() && day.is_some() {
        return Err(UploadError::new(
            "ERROR: CANT SCHEDULE FOR ANOTHER DAY USING 'day' WITHOUT ALSO INCLUDING TIME OF \
             UPLOAD WITH 'schedule'; PLEASE ALSO INCLUDE TIME WITH 'schedule' PARAMETER",
        ));
    }
    Ok(())
}

fn log(enabled: bool, message: impl AsRef<str>) {
    if enabled {
        println!("{}", message.as_ref());
    }
}

/// Upload one video and return `'Completed'` or `'Error'`.
pub fn upload_tiktok(
    video: &str,
    description: &str,
    accountname: &str,
    options: &UploadOptions,
) -> Result<String, UploadError> {
    if accountname.trim().is_empty() {
        return Err(UploadError::new(
            "PLEASE ENTER NAME OF ACCOUNT TO POST ON, READ DOCUMENTATION FOR MORE INFO",
        ));
    }

    let cookies_path = cookie_file(accountname);
    let cookies = load_or_create_cookies(accountname, &cookies_path, options)?;

    let mut bridge = Bridge::connect()?;

    let proxy = match &options.proxy {
        Some(proxy) => proxy.to_json(),
        None => Value::Null,
    };

    step(&mut bridge, "launch", json!({ "headless": options.headless, "proxy": proxy }))?;
    step(&mut bridge, "addCookies", json!({ "cookies": cookies }))?;
    step(&mut bridge, "newPage", json!({}))?;

    log(options.suppress_print == false, format!("Uploading to account '{accountname}'"));

    step(&mut bridge, "goto", json!({ "url": UPLOAD_URL }))?;
    step(&mut bridge, "simulateBrowsing", json!({ "ms": 1500 }))?;

    let captcha = step(&mut bridge, "waitForUploadOrCaptcha", json!({}))?;
    if captcha.as_bool() == Some(true) {
        step(
            &mut bridge,
            "solveCaptcha",
            json!({ "suppressprint": options.suppress_print }),
        )?;
    }

    step(&mut bridge, "setVideo", json!({ "video": video }))?;
    step(
        &mut bridge,
        "descHashtags",
        json!({
            "video": video,
            "description": description,
            "hashtags": options.hashtags,
            "stealth": options.stealth,
            "suppressprint": options.suppress_print,
        }),
    )?;
    step(&mut bridge, "waitForUploadReady", json!({}))?;

    std::thread::sleep(std::time::Duration::from_millis(200));
    log(
        !options.suppress_print,
        "Tik tok done loading file onto servers",
    );

    if !options.visibility.is_empty()
        && options.visibility.to_lowercase() != "everyone"
    {
        step(
            &mut bridge,
            "setVisibility",
            json!({
                "visibility": options.visibility,
                "suppressprint": options.suppress_print,
            }),
        )?;
    }

    step(&mut bridge, "simulateBrowsing", json!({ "ms": 1000 }))?;

    let (schedule, day) = normalize_schedule_and_day(options.schedule.clone(), options.day.clone());
    validate_schedule_request(&schedule, &day)?;

    step(
        &mut bridge,
        "applySchedule",
        json!({
            "schedule": schedule,
            "day": day,
            "stealth": options.stealth,
            "suppressprint": options.suppress_print,
        }),
    )?;

    let sound_fail = step(
        &mut bridge,
        "addSound",
        json!({
            "soundName": options.sound_name,
            "soundAudVol": options.sound_aud_vol,
            "stealth": options.stealth,
            "suppressprint": options.suppress_print,
            "searchMode": options.search_mode,
        }),
    )?;

    if sound_fail.as_bool() == Some(true) {
        // The original saves the video as a draft when the sound cannot be added.
        if step(&mut bridge, "saveDraft", json!({})).is_err() {
            return Err(UploadError::new(
                "ERROR ADDING SOUND; SAVE AS DRAFT BUTTON NOT FOUND SO VIDEO NOT ADDED AS DRAFT",
            ));
        }
        return Err(UploadError::new(
            "ERROR ADDING SOUND: Video saved as draft, please try again or check documentation \
             for more info",
        ));
    }

    if options.copyright_check {
        step(
            &mut bridge,
            "copyrightCheck",
            json!({
                "stealth": options.stealth,
                "suppressprint": options.suppress_print,
            }),
        )?;
    }

    if options.cover_image.is_some() {
        step(&mut bridge, "selectCover", json!({}))?;
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    let result = step(
        &mut bridge,
        "submit",
        json!({
            "schedule": schedule,
            "stealth": options.stealth,
            "suppressprint": options.suppress_print,
            "postSuccessWait": 0.1,
            "scheduleSuccessWait": 0.2,
        }),
    )?;

    let _ = step(&mut bridge, "close", json!({}));

    if result.as_str() == Some("Error") {
        return Ok("Error".to_string());
    }

    Ok("Completed".to_string())
}

/// Read the account's cookies, triggering the interactive login flow when the
/// file is missing or its session has expired.
///
/// Mirrors `loadOrCreateCookies()`: a malformed file is a hard error, not a
/// reason to silently re-login.
fn load_or_create_cookies(
    accountname: &str,
    cookies_path: &PathBuf,
    options: &UploadOptions,
) -> Result<Value, UploadError> {
    if cookies_path.exists() {
        read_cookies(cookies_path)?;

        if check_expiry(cookies_path)? {
            fs::remove_file(cookies_path).map_err(|error| {
                UploadError::new(format!("ERROR: CANT REMOVE EXPIRED COOKIES FILE: {error}"))
            })?;
            log(
                true,
                format!("COOKIES EXPIRED FOR ACCOUNT {accountname}, PLEASE LOG-IN AGAIN"),
            );
            return create_cookies(accountname, cookies_path, options);
        }

        return read_cookies(cookies_path);
    }

    create_cookies(accountname, cookies_path, options)
}

/// Run the visible login flow and adopt the cookie file it writes.
fn create_cookies(
    accountname: &str,
    cookies_path: &PathBuf,
    options: &UploadOptions,
) -> Result<Value, UploadError> {
    log(
        true,
        format!(
            "NO COOKIES FILE FOUND FOR ACCOUNT {accountname}, PLEASE LOG-IN TO {accountname} WHEN \
             PROMPTED"
        ),
    );

    let mut bridge = Bridge::connect()?;
    let proxy = match &options.proxy {
        Some(proxy) => proxy.to_json(),
        None => Value::Null,
    };

    step(&mut bridge, "login", json!({ "proxy": proxy }))?;

    fs::rename("TK_cookies.json", cookies_path)
        .map_err(|error| UploadError::new(format!("ERROR READING COOKIES: {error}")))?;

    read_cookies(cookies_path)
}

/// One bridge call, with the error type callers expect.
fn step(bridge: &mut Bridge, method: &str, params: Value) -> Result<Value, UploadError> {
    bridge.call(method, params).map_err(UploadError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_without_schedule_is_rejected() {
        let error = validate_schedule_request(&None, &Some("25".into())).unwrap_err();
        assert!(error.message.contains("WITHOUT ALSO INCLUDING TIME"));
    }

    #[test]
    fn schedule_without_day_is_allowed() {
        assert!(validate_schedule_request(&Some("12:05".into()), &None).is_ok());
    }

    #[test]
    fn integer_schedule_and_time_day_are_swapped() {
        let (schedule, day) =
            normalize_schedule_and_day(Some("25".into()), Some("12:05".into()));
        assert_eq!(schedule.as_deref(), Some("12:05"));
        assert_eq!(day.as_deref(), Some("25"));
    }

    #[test]
    fn normal_schedule_is_untouched() {
        let (schedule, day) =
            normalize_schedule_and_day(Some("12:05".into()), Some("25".into()));
        assert_eq!(schedule.as_deref(), Some("12:05"));
        assert_eq!(day.as_deref(), Some("25"));
    }
}
