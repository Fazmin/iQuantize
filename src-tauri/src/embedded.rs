//! Files compiled into the binary by build.rs.

use crate::paths::Paths;
use sha2::{Digest, Sha256};

include!(concat!(env!("OUT_DIR"), "/embedded.rs"));

/// Writes the Python drivers to the app data folder when their content changed.
pub fn install_drivers(paths: &Paths) -> std::io::Result<()> {
    let dir = paths.drivers();
    std::fs::create_dir_all(&dir)?;
    for (name, body) in DRIVERS {
        let target = dir.join(name);
        let same = std::fs::read(&target)
            .map(|cur| Sha256::digest(&cur) == Sha256::digest(body.as_bytes()))
            .unwrap_or(false);
        if !same {
            std::fs::write(&target, body)?;
        }
    }
    Ok(())
}
