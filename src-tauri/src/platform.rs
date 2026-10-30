//! OS, architecture and accelerator detection used to pick llama.cpp builds, ONNX
//! execution providers and to decide whether MLX is available.

use regex::Regex;
use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub vendor: String,
    pub name: String,
    pub vram_bytes: Option<u64>,
    pub driver: Option<String>,
    pub cuda_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
    pub os_version: String,
    pub cpu_brand: String,
    pub cores: usize,
    pub total_ram: u64,
    pub apple_silicon: bool,
    pub mlx_supported: bool,
    /// Accelerators llama.cpp could use here, best first (e.g. ["metal"], ["cuda","vulkan","cpu"]).
    pub accelerators: Vec<String>,
    pub gpus: Vec<GpuInfo>,
    pub detected: bool,
}

pub fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    }
}

pub fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        _ => "x86_64",
    }
}

/// Quick, side-effect free info available immediately at startup.
pub fn basic() -> PlatformInfo {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_default();
    let apple_silicon = os_name() == "macos" && arch_name() == "aarch64";
    PlatformInfo {
        os: os_name(),
        arch: arch_name(),
        os_version: sysinfo::System::long_os_version().unwrap_or_default(),
        cpu_brand,
        cores: sys.cpus().len(),
        total_ram: sys.total_memory(),
        apple_silicon,
        mlx_supported: apple_silicon,
        accelerators: if apple_silicon {
            vec!["metal".into(), "cpu".into()]
        } else {
            vec!["cpu".into()]
        },
        gpus: vec![],
        detected: false,
    }
}

/// Slower detection that shells out to vendor tools. Run off the main thread.
pub fn detect() -> PlatformInfo {
    let mut info = basic();
    let mut accels: Vec<String> = vec![];
    if info.apple_silicon {
        accels.push("metal".into());
        info.gpus.push(GpuInfo {
            vendor: "apple".into(),
            name: info.cpu_brand.clone(),
            vram_bytes: Some(info.total_ram),
            driver: None,
            cuda_version: None,
        });
    }
    if let Some(gpus) = detect_nvidia() {
        if !gpus.is_empty() {
            accels.push("cuda".into());
            info.gpus.extend(gpus);
        }
    }
    if info.os == "linux" && detect_rocm() {
        accels.push("rocm".into());
        info.gpus.push(GpuInfo {
            vendor: "amd".into(),
            name: "AMD GPU (ROCm)".into(),
            vram_bytes: None,
            driver: None,
            cuda_version: None,
        });
    }
    if info.os != "macos" && detect_vulkan() {
        accels.push("vulkan".into());
    }
    accels.push("cpu".into());
    info.accelerators = accels;
    info.detected = true;
    info
}

fn quiet(cmd: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

fn detect_nvidia() -> Option<Vec<GpuInfo>> {
    let out = quiet("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total,driver_version",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let cuda_version = quiet("nvidia-smi").output().ok().and_then(|o| {
        let s = String::from_utf8_lossy(&o.stdout).to_string();
        Regex::new(r"CUDA Version:\s*([0-9.]+)")
            .ok()?
            .captures(&s)
            .map(|c| c[1].to_string())
    });
    let text = String::from_utf8_lossy(&out.stdout);
    Some(parse_nvidia_csv(&text, cuda_version))
}

pub fn parse_nvidia_csv(text: &str, cuda_version: Option<String>) -> Vec<GpuInfo> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let parts: Vec<&str> = l.split(',').map(|p| p.trim()).collect();
            GpuInfo {
                vendor: "nvidia".into(),
                name: parts.first().unwrap_or(&"NVIDIA GPU").to_string(),
                vram_bytes: parts
                    .get(1)
                    .and_then(|m| m.parse::<u64>().ok())
                    .map(|mib| mib * 1024 * 1024),
                driver: parts.get(2).map(|d| d.to_string()),
                cuda_version: cuda_version.clone(),
            }
        })
        .collect()
}

fn detect_rocm() -> bool {
    std::path::Path::new("/opt/rocm").exists()
        || quiet("rocminfo")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
}

fn detect_vulkan() -> bool {
    if cfg!(windows) {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        return std::path::Path::new(&sys)
            .join("System32")
            .join("vulkan-1.dll")
            .exists();
    }
    [
        "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
        "/usr/lib/aarch64-linux-gnu/libvulkan.so.1",
        "/usr/lib64/libvulkan.so.1",
        "/usr/lib/libvulkan.so.1",
    ]
    .iter()
    .any(|p| std::path::Path::new(p).exists())
}

/// Recommended memory budget for model weights + KV cache on this machine.
pub fn memory_budget(info: &PlatformInfo) -> u64 {
    if info.apple_silicon {
        // Metal can wire roughly 70–75% of unified memory by default.
        return (info.total_ram as f64 * 0.72) as u64;
    }
    if let Some(v) = info.gpus.iter().filter_map(|g| g.vram_bytes).max() {
        if info.accelerators.iter().any(|a| a == "cuda" || a == "rocm") {
            return (v as f64 * 0.92) as u64;
        }
    }
    (info.total_ram as f64 * 0.6) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvidia_smi_csv() {
        let g = parse_nvidia_csv(
            "NVIDIA GeForce RTX 4090, 24564, 560.94\n",
            Some("12.6".into()),
        );
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].vram_bytes, Some(24564 * 1024 * 1024));
        assert_eq!(g[0].cuda_version.as_deref(), Some("12.6"));
    }
}
