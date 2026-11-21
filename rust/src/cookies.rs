//! Cookie file handling.
//!
//! Cookie file names and JSON shape are kept byte-compatible with the
//! JavaScript/Python library, so a file written by either side works with both:
//! `TK_cookies_<accountname>.json`, an array of Playwright cookie objects.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::error::UploadError;

/// Cookies that decide whether a session is still alive.
const SESSION_COOKIES: [&str; 4] = [
    "sessionid",
    "sid_tt",
    "sessionid_ss",
    "passport_auth_status",
];

const SAME_SITE_VALUES: [&str; 3] = ["Strict", "Lax", "None"];

/// The cookie file for an account, in the current working directory.
pub fn cookie_file(accountname: &str) -> PathBuf {
    PathBuf::from(format!("TK_cookies_{accountname}.json"))
}

/// Read the cookie file and normalize `sameSite` to a value Playwright accepts.
///
/// Mirrors `readCookies()` in `function.js`: an unreadable or malformed file is
/// reported, never silently replaced.
pub fn read_cookies(path: &Path) -> Result<Value, UploadError> {
    let text = fs::read_to_string(path)
        .map_err(|_| UploadError::new("ERROR: CANT READ COOKIES FILE"))?;

    let mut cookies: Value =
        serde_json::from_str(&text).map_err(|_| UploadError::new("ERROR: CANT READ COOKIES FILE"))?;

    let array = cookies
        .as_array_mut()
        .ok_or_else(|| UploadError::new("ERROR: CANT READ COOKIES FILE"))?;

    for cookie in array.iter_mut() {
        let Some(object) = cookie.as_object_mut() else {
            continue;
        };

        let valid = object
            .get("sameSite")
            .and_then(Value::as_str)
            .map(|value| SAME_SITE_VALUES.contains(&value))
            .unwrap_or(false);

        if !valid {
            object.insert("sameSite".to_string(), json!("Lax"));
        }
    }

    Ok(cookies)
}

/// Whether every session cookie in the file has expired.
///
/// Returns `false` when the file holds no session cookies at all, matching
/// `checkExpiry()` in `function.js`.
pub fn check_expiry(path: &Path) -> Result<bool, UploadError> {
    let text = fs::read_to_string(path)
        .map_err(|_| UploadError::new("ERROR: CANT READ COOKIES FILE"))?;

    let cookies: Value =
        serde_json::from_str(&text).map_err(|_| UploadError::new("ERROR: CANT READ COOKIES FILE"))?;

    let array = cookies
        .as_array()
        .ok_or_else(|| UploadError::new("ERROR: CANT READ COOKIES FILE"))?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);

    let mut states = Vec::new();

    for cookie in array {
        let Some(name) = cookie.get("name").and_then(Value::as_str) else {
            continue;
        };

        if !SESSION_COOKIES.contains(&name) {
            continue;
        }

        // Playwright writes `expires`; older cookie exports use `expirationDate`.
        let expires = cookie
            .get("expires")
            .and_then(Value::as_f64)
            .or_else(|| cookie.get("expirationDate").and_then(Value::as_f64));

        // A cookie without an expiry is a session cookie and counts as valid.
        states.push(matches!(expires, Some(expiry) if expiry < now as f64));
    }

    Ok(!states.is_empty() && states.iter().all(|expired| *expired))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(contents: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tk-cookies-test-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(contents.as_bytes()).unwrap();
        path
    }

    #[test]
    fn cookie_file_name_matches_javascript() {
        assert_eq!(cookie_file("main"), PathBuf::from("TK_cookies_main.json"));
    }

    #[test]
    fn expired_session_cookies_are_detected() {
        let path = write_temp(r#"[{"name":"sessionid","expires":1},{"name":"sid_tt","expires":2}]"#);
        assert!(check_expiry(&path).unwrap());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn live_session_cookies_are_not_expired() {
        let path = write_temp(
            r#"[{"name":"sessionid","expires":4102444800},{"name":"passport_auth_status","expirationDate":4102444800}]"#,
        );
        assert!(!check_expiry(&path).unwrap());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn non_session_cookies_never_count_as_an_expired_session() {
        let path = write_temp(r#"[{"name":"ttwid","expires":1}]"#);
        assert!(!check_expiry(&path).unwrap());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn unknown_same_site_is_normalized() {
        let path = write_temp(r#"[{"name":"a","sameSite":"weird"},{"name":"b","sameSite":"None"}]"#);
        let cookies = read_cookies(&path).unwrap();
        assert_eq!(cookies[0]["sameSite"], json!("Lax"));
        assert_eq!(cookies[1]["sameSite"], json!("None"));
        fs::remove_file(path).unwrap();
    }
}
