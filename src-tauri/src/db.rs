//! SQLite access. One connection behind a mutex (WAL mode); queries are short.

use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OptionalExtension, Transaction};
use std::path::Path;
use std::sync::Mutex;

const MIGRATIONS: &[&str] = &[include_str!("../migrations/0001_init.sql")];

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> AppResult<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> AppResult<T> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::new("db", "Database lock poisoned"))?;
        Ok(f(&conn)?)
    }

    pub fn tx<T>(&self, f: impl FnOnce(&Transaction) -> AppResult<T>) -> AppResult<T> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| AppError::new("db", "Database lock poisoned"))?;
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    pub fn setting(&self, key: &str) -> AppResult<Option<String>> {
        self.with(|c| {
            c.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()
        })
    }

    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value],
            )
        })?;
        Ok(())
    }
}

fn migrate(conn: &Connection) -> AppResult<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let version = (i + 1) as i64;
        if version > current {
            conn.execute_batch(&format!(
                "BEGIN; {sql}\nPRAGMA user_version = {version}; COMMIT;"
            ))
            .map_err(|e| AppError::new("db", format!("Migration {version} failed: {e}")))?;
        }
    }
    Ok(())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Reads a JSON text column into a serde_json::Value (Null when absent or invalid).
pub fn json_col(v: Option<String>) -> serde_json::Value {
    v.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_migration_and_settings_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let v: i64 = db
            .with(|c| c.query_row("PRAGMA user_version", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
        db.set_setting("theme", "dark").unwrap();
        db.set_setting("theme", "light").unwrap();
        assert_eq!(db.setting("theme").unwrap().as_deref(), Some("light"));
        let featured: i64 = db
            .with(|c| c.query_row("SELECT COUNT(*) FROM ai_models", [], |r| r.get(0)))
            .unwrap();
        assert!(featured >= 9);
    }

    #[test]
    fn migration_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("iq-db-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.db");
        drop(Db::open(&p).unwrap());
        let db = Db::open(&p).unwrap();
        let v: i64 = db
            .with(|c| c.query_row("PRAGMA user_version", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
        let _ = std::fs::remove_dir_all(dir);
    }
}
