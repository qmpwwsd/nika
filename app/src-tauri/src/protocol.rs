//! Shell <-> server stdio protocol, `proto` 1: one JSON object per line (docs/contracts/api-app.md section 5).
//! Everything read from the child is untrusted text: lines are bounded, unknown types are ignored, numbers and ids
//! are validated, names are stripped of control and bidi characters before they reach a menu.

use serde::Serialize;
use serde_json::{Map, Value};
use std::io::{self, BufRead};
use std::path::Path;

use crate::secret::Secret;

pub const PROTO: u64 = 1;
/// A line longer than this (without its newline) is discarded through the next newline.
pub const MAX_LINE: usize = 64 * 1024;
pub const MAX_PROJECTS: usize = 8;
const MAX_COUNT: u64 = 1_000_000;
const MAX_NAME_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Status {
    pub busy: u32,
    pub idle: u32,
    pub other: u32,
    pub ended: u32,
    pub attention: u32,
    pub projects: Vec<ProjectStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatus {
    pub key: String,
    pub name: String,
    pub busy: u32,
    pub idle: u32,
    pub attention: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Msg {
    Ready { port: u16 },
    /// A `ready` with the wrong `proto` or a port outside 1-65535: the shell treats it as a failed start.
    BadReady,
    Status(Status),
    PickFolder { req_id: String },
    Error { message: String },
}

/// `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`
pub fn valid_req_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `^[a-z0-9]{16}$` (`keyFor` in src/store.js)
pub fn valid_project_key(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// A picked folder is sent back only when it is an absolute path to an existing directory.
pub fn valid_folder(p: &Path) -> bool {
    p.is_absolute() && std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

/// Display text from the child: no control characters, no bidi or zero-width controls, bounded, trimmed.
pub fn clean(s: &str) -> String {
    let kept: String = s
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .take(MAX_NAME_CHARS)
        .collect();
    kept.trim().to_string()
}

fn count(v: Option<&Value>) -> Option<u32> {
    // as_u64 is None for negatives, floats (even 1.0) and non-numbers
    v?.as_u64().filter(|n| *n <= MAX_COUNT).map(|n| n as u32)
}

fn parse_ready(obj: &Map<String, Value>) -> Msg {
    let proto_ok = obj.get("proto").and_then(Value::as_u64) == Some(PROTO);
    match obj.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()) {
        Some(port) if proto_ok && port >= 1 => Msg::Ready { port },
        _ => Msg::BadReady,
    }
}

fn parse_project(v: &Value) -> Option<ProjectStatus> {
    let o = v.as_object()?;
    let key = o.get("key")?.as_str()?;
    if !valid_project_key(key) {
        return None;
    }
    Some(ProjectStatus {
        key: key.to_string(),
        name: clean(o.get("name")?.as_str()?),
        busy: count(o.get("busy"))?,
        idle: count(o.get("idle"))?,
        attention: count(o.get("attention"))?,
    })
}

fn parse_status(obj: &Map<String, Value>) -> Option<Status> {
    // a bad count rejects the whole message; a bad project entry is skipped on its own
    Some(Status {
        busy: count(obj.get("busy"))?,
        idle: count(obj.get("idle"))?,
        other: count(obj.get("other"))?,
        ended: count(obj.get("ended"))?,
        attention: count(obj.get("attention"))?,
        projects: obj
            .get("projects")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(parse_project).take(MAX_PROJECTS).collect())
            .unwrap_or_default(),
    })
}

/// One line from the child. `None`: not JSON, not an object, unknown `type` or an invalid message (all ignored).
pub fn parse_line(line: &str) -> Option<Msg> {
    let v: Value = serde_json::from_str(line).ok()?;
    let obj = v.as_object()?;
    match obj.get("type")?.as_str()? {
        "ready" => Some(parse_ready(obj)),
        "status" => parse_status(obj).map(Msg::Status),
        "pick-folder" => {
            let id = obj.get("reqId")?.as_str()?;
            valid_req_id(id).then(|| Msg::PickFolder { req_id: id.to_string() })
        }
        "error" => Some(Msg::Error { message: clean(obj.get("message").and_then(Value::as_str).unwrap_or("")) }),
        _ => None,
    }
}

/// Calls `on_line` for every `\n`-terminated UTF-8 line of at most `MAX_LINE` bytes. Longer lines are dropped without
/// ever being held in memory; a last line without a newline is dropped too. Returns at EOF.
pub fn read_lines<R: BufRead>(mut r: R, mut on_line: impl FnMut(&str)) -> io::Result<()> {
    let mut line: Vec<u8> = Vec::new();
    let mut discarding = false;
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Ok(());
        }
        match buf.iter().position(|b| *b == b'\n') {
            Some(i) => {
                if !discarding {
                    line.extend_from_slice(&buf[..i]);
                    if line.len() <= MAX_LINE {
                        if let Ok(s) = std::str::from_utf8(&line) {
                            on_line(s);
                        }
                    }
                }
                line.clear();
                discarding = false;
                r.consume(i + 1);
            }
            None => {
                let n = buf.len();
                if !discarding {
                    if line.len() + n > MAX_LINE {
                        discarding = true;
                        line.clear();
                    } else {
                        line.extend_from_slice(buf);
                    }
                }
                r.consume(n);
            }
        }
    }
}

#[derive(Serialize)]
struct Hello<'a> {
    r#type: &'a str,
    proto: u64,
    secret: &'a str,
}

#[derive(Serialize)]
struct Folder<'a> {
    r#type: &'a str,
    #[serde(rename = "reqId")]
    req_id: &'a str,
    path: Option<&'a str>,
}

/// The first line the server must receive. Holds the secret: write it to the pipe and drop it, never log it.
pub fn hello_line(secret: &Secret) -> String {
    let mut s = serde_json::to_string(&Hello { r#type: "hello", proto: PROTO, secret: secret.expose() }).expect("hello serialises");
    s.push('\n');
    s
}

pub fn folder_line(req_id: &str, path: Option<&str>) -> String {
    let mut s = serde_json::to_string(&Folder { r#type: "folder", req_id, path }).expect("folder serialises");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const KEY: &str = "0123456789abcdef";
    const REQ: &str = "11111111-1111-4111-8111-111111111111";

    fn lines(input: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        read_lines(Cursor::new(input), |l| out.push(l.to_string())).unwrap();
        out
    }

    #[test]
    fn ready_valid() {
        // (+)
        assert_eq!(parse_line(r#"{"type":"ready","proto":1,"port":4321,"version":"0.2.0"}"#), Some(Msg::Ready { port: 4321 }));
        assert_eq!(parse_line(r#"{"type":"ready","proto":1,"port":65535}"#), Some(Msg::Ready { port: 65535 }));
        assert_eq!(parse_line(r#"{"type":"ready","proto":1,"port":1}"#), Some(Msg::Ready { port: 1 }));
    }

    #[test]
    fn ready_bad_port_or_proto() {
        // (-) port 0, 65536, negative, float, string, missing; proto 2, 1.0, missing
        for bad in [
            r#"{"type":"ready","proto":1,"port":0}"#,
            r#"{"type":"ready","proto":1,"port":65536}"#,
            r#"{"type":"ready","proto":1,"port":-5}"#,
            r#"{"type":"ready","proto":1,"port":80.5}"#,
            r#"{"type":"ready","proto":1,"port":"80"}"#,
            r#"{"type":"ready","proto":1}"#,
            r#"{"type":"ready","proto":2,"port":4321}"#,
            r#"{"type":"ready","proto":1.0,"port":4321}"#,
            r#"{"type":"ready","port":4321}"#,
        ] {
            assert_eq!(parse_line(bad), Some(Msg::BadReady), "{bad}");
        }
    }

    #[test]
    fn status_valid() {
        // (+) counts, projects capped at 8, control and bidi characters stripped from names
        let mut projects = String::new();
        for i in 0..10 {
            projects.push_str(&format!(r#"{{"key":"{KEY}","name":"p{i}","busy":1,"idle":2,"attention":3}},"#));
        }
        projects.pop();
        let line = format!(r#"{{"type":"status","busy":1,"idle":2,"other":3,"ended":4,"attention":5,"projects":[{projects}]}}"#);
        let Some(Msg::Status(s)) = parse_line(&line) else { panic!("status expected") };
        assert_eq!((s.busy, s.idle, s.other, s.ended, s.attention), (1, 2, 3, 4, 5));
        assert_eq!(s.projects.len(), MAX_PROJECTS);
        assert_eq!(s.projects[0], ProjectStatus { key: KEY.into(), name: "p0".into(), busy: 1, idle: 2, attention: 3 });

        let line = format!(r#"{{"type":"status","busy":0,"idle":0,"other":0,"ended":0,"attention":0,"projects":[{{"key":"{KEY}","name":"a\u001b[2Jb\u202ec\u0007","busy":0,"idle":0,"attention":0}}]}}"#);
        let Some(Msg::Status(s)) = parse_line(&line) else { panic!("status expected") };
        assert_eq!(s.projects[0].name, "a[2Jbc");
    }

    #[test]
    fn status_without_projects_is_fine() {
        // (+)
        let Some(Msg::Status(s)) = parse_line(r#"{"type":"status","busy":0,"idle":0,"other":0,"ended":0,"attention":0}"#) else { panic!() };
        assert!(s.projects.is_empty());
    }

    #[test]
    fn status_negative_float_or_missing_counts_are_ignored() {
        // (-) the whole message is dropped
        for bad in [
            r#"{"type":"status","busy":-1,"idle":0,"other":0,"ended":0,"attention":0}"#,
            r#"{"type":"status","busy":1.5,"idle":0,"other":0,"ended":0,"attention":0}"#,
            r#"{"type":"status","busy":2.0,"idle":0,"other":0,"ended":0,"attention":0}"#,
            r#"{"type":"status","busy":"1","idle":0,"other":0,"ended":0,"attention":0}"#,
            r#"{"type":"status","busy":1000001,"idle":0,"other":0,"ended":0,"attention":0}"#,
            r#"{"type":"status","busy":1,"idle":0,"other":0,"ended":0}"#,
            r#"{"type":"status","busy":null,"idle":0,"other":0,"ended":0,"attention":0}"#,
        ] {
            assert_eq!(parse_line(bad), None, "{bad}");
        }
    }

    #[test]
    fn status_bad_project_keys_are_skipped_not_fatal() {
        // (-) path-like, short, upper case, non-string, missing: only the valid entry survives
        let line = format!(
            r#"{{"type":"status","busy":0,"idle":0,"other":0,"ended":0,"attention":0,"projects":[
              {{"key":"../../etc/passwd!","name":"a","busy":0,"idle":0,"attention":0}},
              {{"key":"abc","name":"b","busy":0,"idle":0,"attention":0}},
              {{"key":"0123456789ABCDEF","name":"c","busy":0,"idle":0,"attention":0}},
              {{"key":5,"name":"d","busy":0,"idle":0,"attention":0}},
              {{"name":"e","busy":0,"idle":0,"attention":0}},
              {{"key":"{KEY}","name":"ok","busy":0,"idle":0,"attention":-1}},
              {{"key":"{KEY}","name":"ok","busy":0,"idle":0,"attention":0}}]}}"#
        );
        let Some(Msg::Status(s)) = parse_line(&line) else { panic!() };
        assert_eq!(s.projects.len(), 1);
        assert_eq!(s.projects[0].name, "ok");
    }

    #[test]
    fn pick_folder_requires_a_uuid_shaped_req_id() {
        // (+)
        assert_eq!(parse_line(&format!(r#"{{"type":"pick-folder","reqId":"{REQ}"}}"#)), Some(Msg::PickFolder { req_id: REQ.into() }));
        // (-)
        for bad in ["", "abc", "11111111111111111111111111111111", "11111111-1111-4111-8111-11111111111", "11111111-1111-4111-8111-1111111111111", "1111111g-1111-4111-8111-111111111111", "11111111_1111-4111-8111-111111111111", "../../x"] {
            assert!(!valid_req_id(bad), "{bad}");
            assert_eq!(parse_line(&format!(r#"{{"type":"pick-folder","reqId":"{bad}"}}"#)), None, "{bad}");
        }
        assert_eq!(parse_line(r#"{"type":"pick-folder"}"#), None);
        assert_eq!(parse_line(r#"{"type":"pick-folder","reqId":7}"#), None);
    }

    #[test]
    fn error_message_is_cleaned() {
        // (+)
        assert_eq!(parse_line("{\"type\":\"error\",\"message\":\"port in use\\n\\u001b]0;x\\u0007\"}"), Some(Msg::Error { message: "port in use]0;x".into() }));
        assert_eq!(parse_line(r#"{"type":"error"}"#), Some(Msg::Error { message: String::new() }));
    }

    #[test]
    fn unknown_type_bad_json_and_non_objects_are_ignored() {
        // (-)
        for bad in [
            r#"{"type":"future-thing","x":1}"#,
            r#"{"type":5}"#,
            r#"{"nope":1}"#,
            "not json",
            "",
            "[]",
            "42",
            "null",
            r#"{"type":"ready","proto":1,"port":4321"#,
        ] {
            assert_eq!(parse_line(bad), None, "{bad}");
        }
    }

    #[test]
    fn read_lines_splits_and_bounds() {
        // (+) normal lines, CRLF kept (JSON tolerates it), empty lines, a final line without newline is dropped
        assert_eq!(lines(b"a\nb\r\n\nc"), vec!["a", "b\r", ""]);
        // (+) exactly the limit passes
        let ok = vec![b'x'; MAX_LINE];
        let mut input = ok.clone();
        input.push(b'\n');
        assert_eq!(lines(&input), vec![String::from_utf8(ok).unwrap()]);
        // (-) one byte over: discarded through the newline, the next line still arrives
        let mut input = vec![b'x'; MAX_LINE + 1];
        input.extend_from_slice(b"\nnext\n");
        assert_eq!(lines(&input), vec!["next"]);
        // (-) a huge line spanning many reads, then a normal one
        let mut input = vec![b'y'; MAX_LINE * 20];
        input.extend_from_slice(b"\nafter\n");
        assert_eq!(lines(&input), vec!["after"]);
        // (-) invalid UTF-8 is skipped
        assert_eq!(lines(b"\xff\xfe\nok\n"), vec!["ok"]);
    }

    #[test]
    fn read_lines_over_64k_message_is_not_parsed() {
        // (-) a status line padded past the limit is ignored by the whole pipeline
        let pad = "x".repeat(MAX_LINE);
        let line = format!(r#"{{"type":"status","busy":1,"idle":0,"other":0,"ended":0,"attention":0,"pad":"{pad}"}}"#);
        assert!(line.len() > MAX_LINE);
        let mut got = Vec::new();
        read_lines(Cursor::new(format!("{line}\n")), |l| got.extend(parse_line(l))).unwrap();
        assert!(got.is_empty());
    }

    #[test]
    fn outgoing_lines() {
        // (+) hello carries proto 1 and the 43-char secret and ends with one newline
        let secret = Secret::generate().unwrap();
        let hello = hello_line(&secret);
        assert!(hello.ends_with('\n') && hello.matches('\n').count() == 1);
        let v: Value = serde_json::from_str(&hello).unwrap();
        assert_eq!(v["type"], "hello");
        assert_eq!(v["proto"], 1);
        assert_eq!(v["secret"].as_str().unwrap(), secret.expose());
        assert_eq!(v["secret"].as_str().unwrap().len(), 43);
        // (+) folder with a path and with null
        assert_eq!(folder_line(REQ, Some("/tmp/x")), format!("{{\"type\":\"folder\",\"reqId\":\"{REQ}\",\"path\":\"/tmp/x\"}}\n"));
        assert_eq!(folder_line(REQ, None), format!("{{\"type\":\"folder\",\"reqId\":\"{REQ}\",\"path\":null}}\n"));
        // (-) a path with quotes and newlines stays one JSON line
        let tricky = folder_line(REQ, Some("/tmp/a\"b\nc"));
        assert_eq!(tricky.matches('\n').count(), 1);
        assert_eq!(serde_json::from_str::<Value>(&tricky).unwrap()["path"], "/tmp/a\"b\nc");
    }

    #[test]
    fn project_key_validation() {
        // (+) / (-)
        assert!(valid_project_key(KEY));
        assert!(valid_project_key("abcdefghijklmnop"));
        for bad in ["", "0123456789abcde", "0123456789abcdef0", "0123456789ABCDEF", "0123456789abcde/", "0123456789abcdé", "../0123456789abc", "0123456789abcde\n"] {
            assert!(!valid_project_key(bad), "{bad:?}");
        }
    }

    #[test]
    fn folder_validation() {
        // (+) an absolute existing directory
        let dir = std::env::temp_dir();
        assert!(valid_folder(&dir));
        // (-) relative, missing, a regular file, empty
        assert!(!valid_folder(Path::new("relative/dir")));
        assert!(!valid_folder(Path::new(".")));
        assert!(!valid_folder(&dir.join("nika-no-such-dir-3f9a")));
        let file = dir.join(format!("nika-folder-test-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        assert!(!valid_folder(&file));
        std::fs::remove_file(&file).unwrap();
        assert!(!valid_folder(Path::new("")));
    }
}
