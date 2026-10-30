//! Secrets (Hugging Face token, OpenAI key) are stored in SQLite encrypted with
//! XChaCha20-Poly1305. The 32-byte master key lives in the OS keychain (macOS Keychain,
//! Windows Credential Manager, Linux Secret Service). If no keychain is reachable we fall
//! back to a 0600 key file and surface a warning in Settings.
//!
//! The key is loaded lazily, so the OS never prompts for keychain access unless a secret
//! is actually read or written.

use crate::db::{now_ms, Db};
use crate::error::{AppError, AppResult};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &str = "com.iquantize.desktop";
const ACCOUNT: &str = "master-key";

pub const HF_TOKEN: &str = "hf_token";
pub const OPENAI_KEY: &str = "openai_api_key";

#[derive(Debug, Clone, Serialize)]
pub struct SecretStatus {
    pub name: String,
    pub hint: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecretsBackend {
    pub kind: String,
    pub warning: Option<String>,
}

pub struct Secrets {
    db: Arc<Db>,
    key_file: PathBuf,
    key: Mutex<Option<Zeroizing<[u8; 32]>>>,
    backend: Mutex<SecretsBackend>,
}

impl Secrets {
    pub fn new(db: Arc<Db>, data_dir: PathBuf) -> Self {
        Self {
            db,
            key_file: data_dir.join("master.key"),
            key: Mutex::new(None),
            backend: Mutex::new(SecretsBackend {
                kind: "os-keychain".into(),
                warning: None,
            }),
        }
    }

    pub fn backend(&self) -> SecretsBackend {
        self.backend
            .lock()
            .map(|b| b.clone())
            .unwrap_or(SecretsBackend {
                kind: "unknown".into(),
                warning: None,
            })
    }

    fn cipher(&self) -> AppResult<XChaCha20Poly1305> {
        let mut guard = self
            .key
            .lock()
            .map_err(|_| AppError::new("secrets", "Key lock poisoned"))?;
        if guard.is_none() {
            *guard = Some(self.load_or_create_key()?);
        }
        let key = guard.as_ref().expect("key loaded");
        Ok(XChaCha20Poly1305::new(key.as_ref().into()))
    }

    fn load_or_create_key(&self) -> AppResult<Zeroizing<[u8; 32]>> {
        let force_file = std::env::var("IQUANTIZE_KEY_FILE")
            .map(|v| v == "1")
            .unwrap_or(false);
        if !force_file {
            match self.keychain_key() {
                Ok(k) => return Ok(k),
                Err(e) => {
                    tracing::warn!("keychain unavailable, using key file: {e}");
                    if let Ok(mut b) = self.backend.lock() {
                        *b = SecretsBackend {
                            kind: "key-file".into(),
                            warning: Some(format!(
                                "The OS keychain is not available ({e}). Secrets are encrypted with a key stored in a private file in the app data folder."
                            )),
                        };
                    }
                }
            }
        } else if let Ok(mut b) = self.backend.lock() {
            *b = SecretsBackend {
                kind: "key-file".into(),
                warning: Some("Key-file mode forced by IQUANTIZE_KEY_FILE.".into()),
            };
        }
        self.file_key()
    }

    fn keychain_key(&self) -> Result<Zeroizing<[u8; 32]>, String> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(hex_key) => {
                decode_key(&hex_key).ok_or_else(|| "stored master key is malformed".to_string())
            }
            Err(keyring::Error::NoEntry) => {
                let key = fresh_key();
                let mut encoded = hex::encode(key.as_ref());
                let res = entry.set_password(&encoded);
                encoded.zeroize();
                res.map_err(|e| e.to_string())?;
                // Read back to be sure the backend actually persisted it.
                let check = entry.get_password().map_err(|e| e.to_string())?;
                decode_key(&check).ok_or_else(|| "keychain did not persist the key".to_string())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    fn file_key(&self) -> AppResult<Zeroizing<[u8; 32]>> {
        if let Ok(s) = std::fs::read_to_string(&self.key_file) {
            if let Some(k) = decode_key(s.trim()) {
                return Ok(k);
            }
        }
        let key = fresh_key();
        let encoded = Zeroizing::new(hex::encode(key.as_ref()));
        write_private(&self.key_file, encoded.as_bytes())?;
        Ok(key)
    }

    pub fn set(&self, name: &str, value: &str) -> AppResult<SecretStatus> {
        let value = value.trim();
        if value.is_empty() {
            return Err(AppError::invalid("The value is empty"));
        }
        let cipher = self.cipher()?;
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ct = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: value.as_bytes(),
                    aad: name.as_bytes(),
                },
            )
            .map_err(|_| AppError::new("secrets", "Encryption failed"))?;
        let hint = hint_for(value);
        let ts = now_ms();
        self.db.with(|c| {
            c.execute(
                "INSERT INTO secrets (name, nonce, ciphertext, hint, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(name) DO UPDATE SET nonce = excluded.nonce, ciphertext = excluded.ciphertext,
                 hint = excluded.hint, updated_at = excluded.updated_at",
                rusqlite::params![name, nonce.as_slice(), ct, hint, ts],
            )
        })?;
        Ok(SecretStatus {
            name: name.into(),
            hint,
            updated_at: ts,
        })
    }

    /// Decrypts a secret. The returned string is zeroized on drop.
    pub fn get(&self, name: &str) -> AppResult<Option<Zeroizing<String>>> {
        let row: Option<(Vec<u8>, Vec<u8>)> = self.db.with(|c| {
            c.query_row(
                "SELECT nonce, ciphertext FROM secrets WHERE name = ?1",
                [name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
        })?;
        let Some((nonce, ct)) = row else {
            return Ok(None);
        };
        if nonce.len() != 24 {
            return Err(AppError::new("secrets", "Stored secret is corrupted"));
        }
        let cipher = self.cipher()?;
        let pt = cipher
            .decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: name.as_bytes() })
            .map_err(|_| {
                AppError::new("secrets", "Could not decrypt the stored secret").with_hint(
                    "The encryption key in your keychain changed. Re-enter the key or token in Settings.",
                )
            })?;
        let s = String::from_utf8(pt)
            .map_err(|_| AppError::new("secrets", "Stored secret is not valid text"))?;
        Ok(Some(Zeroizing::new(s)))
    }

    pub fn require(&self, name: &str, label: &str) -> AppResult<Zeroizing<String>> {
        self.get(name)?.ok_or_else(|| {
            AppError::new("missing_secret", format!("No {label} is configured"))
                .with_hint("Add it in Settings → Accounts.")
        })
    }

    pub fn delete(&self, name: &str) -> AppResult<()> {
        self.db
            .with(|c| c.execute("DELETE FROM secrets WHERE name = ?1", [name]))?;
        Ok(())
    }

    pub fn status(&self) -> AppResult<Vec<SecretStatus>> {
        self.db.with(|c| {
            let mut st = c.prepare("SELECT name, hint, updated_at FROM secrets ORDER BY name")?;
            let rows = st.query_map([], |r| {
                Ok(SecretStatus {
                    name: r.get(0)?,
                    hint: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })?;
            rows.collect()
        })
    }
}

fn fresh_key() -> Zeroizing<[u8; 32]> {
    let k = XChaCha20Poly1305::generate_key(&mut OsRng);
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(k.as_slice());
    out
}

fn decode_key(s: &str) -> Option<Zeroizing<[u8; 32]>> {
    let bytes = Zeroizing::new(hex::decode(s.trim()).ok()?);
    if bytes.len() != 32 {
        return None;
    }
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&bytes);
    Some(out)
}

fn hint_for(value: &str) -> String {
    let tail: String = value
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("••••{tail}")
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Secrets, PathBuf) {
        std::env::set_var("IQUANTIZE_KEY_FILE", "1");
        let dir = std::env::temp_dir().join(format!("iq-secrets-{}", crate::db::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        (
            Secrets::new(Arc::new(Db::open_in_memory().unwrap()), dir.clone()),
            dir,
        )
    }

    #[test]
    fn roundtrip_and_hint() {
        let (s, dir) = store();
        let st = s.set(HF_TOKEN, "hf_abcdefgh1234").unwrap();
        assert_eq!(st.hint, "••••1234");
        assert_eq!(
            s.get(HF_TOKEN).unwrap().unwrap().as_str(),
            "hf_abcdefgh1234"
        );
        assert!(s.get(OPENAI_KEY).unwrap().is_none());
        s.delete(HF_TOKEN).unwrap();
        assert!(s.get(HF_TOKEN).unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ciphertext_is_bound_to_name() {
        let (s, dir) = store();
        s.set(HF_TOKEN, "secret-value").unwrap();
        // Move the ciphertext to a different name: AAD mismatch must fail decryption.
        s.db.with(|c| {
            c.execute(
                "UPDATE secrets SET name = ?1 WHERE name = ?2",
                [OPENAI_KEY, HF_TOKEN],
            )
        })
        .unwrap();
        assert!(s.get(OPENAI_KEY).is_err());
        let raw: Vec<u8> =
            s.db.with(|c| c.query_row("SELECT ciphertext FROM secrets", [], |r| r.get(0)))
                .unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("secret-value"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
