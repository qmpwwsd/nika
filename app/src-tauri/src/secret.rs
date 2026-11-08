//! The per-launch secret: 32 random bytes from the OS, base64url without padding (43 chars).
//! It lives in memory only: it is written once to the child's stdin and put into the page by the init script.
//! `Debug` never prints it, and there is no `Display`, `Clone` or serialisation.

use std::fmt;
use std::fs::File;
use std::io::{self, Read};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const SECRET_BYTES: usize = 32;

/// RFC 4648 section 5 (URL-safe alphabet), no padding.
pub fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        // 1 byte gives 2 characters, 2 bytes give 3, 3 bytes give 4
        for i in 0..=chunk.len() {
            out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

pub struct Secret(String);

impl Secret {
    pub fn generate() -> io::Result<Self> {
        let mut bytes = [0u8; SECRET_BYTES];
        File::open("/dev/urandom")?.read_exact(&mut bytes)?;
        Ok(Self(base64url(&bytes)))
    }

    /// The only way to read the value; call sites are the hello line and the init script.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4648_vectors() {
        // (+) the RFC 4648 section 10 vectors, padding removed
        for (raw, want) in [("", ""), ("f", "Zg"), ("fo", "Zm8"), ("foo", "Zm9v"), ("foob", "Zm9vYg"), ("fooba", "Zm9vYmE"), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64url(raw.as_bytes()), want, "{raw:?}");
        }
    }

    #[test]
    fn url_safe_alphabet_not_standard() {
        // (+) 62 and 63 are '-' and '_'; (-) '+', '/' and '=' never appear
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(base64url(&[0xff, 0xff, 0xff]), "____");
        assert_eq!(base64url(&[0xfb]), "-w");
        let all: Vec<u8> = (0..=255).collect();
        let s = base64url(&all);
        assert!(!s.contains(['+', '/', '=']));
        assert_eq!(s.len(), 342); // ceil(256 * 4 / 3)
    }

    #[test]
    fn generated_secret_is_43_url_safe_chars_and_differs_per_call() {
        // (+) 32 bytes encode to exactly 43 characters of the URL-safe alphabet
        let a = Secret::generate().unwrap();
        let b = Secret::generate().unwrap();
        assert_eq!(a.expose().len(), 43);
        assert!(a.expose().bytes().all(|c| ALPHABET.contains(&c)));
        // (-) two launches never share a secret
        assert_ne!(a.expose(), b.expose());
    }

    #[test]
    fn debug_never_prints_the_secret() {
        // (-) neither the type nor a struct or Option holding it leaks the value through {:?} or {:#?}
        #[derive(Debug)]
        struct Holder {
            _s: Option<Secret>,
        }
        let s = Secret::generate().unwrap();
        let value = s.expose().to_string();
        let h = Holder { _s: Some(s) };
        for text in [format!("{h:?}"), format!("{h:#?}")] {
            assert!(!text.contains(&value), "{text}");
            assert!(text.contains("***"));
        }
    }
}
