use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::Result;
use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub bots: Vec<BotStatus>,
    pub warnings: usize,
    pub pm2_online: bool,
    pub pm2_processes: usize,
    pub alerts: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct BotStatus {
    pub name: String,
    pub pair: String,
    pub active: bool,
    pub runtime_status: String,
    pub log_path: Option<String>,
    pub log_tail: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct BotsFile {
    #[serde(default)]
    bots: Vec<BotEntry>,
}

#[derive(Debug, Deserialize)]
struct BotEntry {
    name: Option<String>,
    #[serde(default)]
    #[serde(rename = "assetA")]
    asset_a: String,
    #[serde(default)]
    #[serde(rename = "assetB")]
    asset_b: String,
    active: Option<bool>,
}

pub fn load_snapshot() -> Result<Snapshot> {
    let bots_path = PathBuf::from("profiles/bots.json");
    let mut bots = Vec::new();
    let mut warnings = 0;
    let mut alerts = Vec::new();

    let (pm2_map, pm2_online) = load_pm2_status();
    let pm2_processes = pm2_map.len();
    if !pm2_online {
        warnings += 1;
        alerts.push(String::from("PM2 unavailable (pm2 jlist failed or not installed)."));
    }

    if bots_path.exists() {
        let raw = fs::read_to_string(&bots_path)?;
        let parsed: BotsFile = serde_json::from_str(&raw).unwrap_or_else(|_| BotsFile { bots: vec![] });

        for (index, entry) in parsed.bots.iter().enumerate() {
            let name = entry
                .name
                .clone()
                .unwrap_or_else(|| format!("bot-{}", index + 1));
            let pair = if entry.asset_a.is_empty() || entry.asset_b.is_empty() {
                warnings += 1;
                String::from("?/ ?")
            } else {
                format!("{}/{}", entry.asset_a, entry.asset_b)
            };

            let active = entry.active.unwrap_or(true);
            let runtime_status = if let Some(status) = pm2_map.get(&name) {
                status.clone()
            } else if active {
                String::from("not-running")
            } else {
                String::from("disabled")
            };

            let log_path = resolve_bot_log_path(&name);
            let log_tail = log_path
                .as_ref()
                .map(|p| tail_lines(Path::new(p), 10))
                .unwrap_or_default();

            if log_tail.iter().any(|line| has_error_marker(line)) {
                warnings += 1;
                alerts.push(format!("{name}: error/warn marker found in recent log lines."));
            }

            bots.push(BotStatus {
                name,
                pair,
                active,
                runtime_status,
                log_path,
                log_tail,
            });
        }
    } else {
        warnings += 1;
        alerts.push(String::from("profiles/bots.json not found."));
    }

    Ok(Snapshot {
        bots,
        warnings,
        pm2_online,
        pm2_processes,
        alerts,
    })
}

fn load_pm2_status() -> (HashMap<String, String>, bool) {
    let output = Command::new("pm2").arg("jlist").output();
    let Ok(output) = output else {
        return (HashMap::new(), false);
    };
    if !output.status.success() {
        return (HashMap::new(), false);
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let json_start = text.find('[').unwrap_or(0);
    let payload = &text[json_start..];
    let parsed = serde_json::from_str::<serde_json::Value>(payload);
    let Ok(value) = parsed else {
        return (HashMap::new(), false);
    };

    let Some(items) = value.as_array() else {
        return (HashMap::new(), false);
    };

    let mut map = HashMap::new();
    for item in items {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let status = item
            .get("pm2_env")
            .and_then(|env| env.get("status"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        map.insert(name, status);
    }
    (map, true)
}

fn resolve_bot_log_path(bot_name: &str) -> Option<String> {
    let direct = PathBuf::from(format!("profiles/logs/{bot_name}.log"));
    if direct.exists() {
        return Some(direct.to_string_lossy().to_string());
    }

    let logs_dir = PathBuf::from("profiles/logs");
    if !logs_dir.exists() {
        return None;
    }

    let mut candidates = fs::read_dir(logs_dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .map(|ext| ext == "log")
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    candidates.sort_by_key(|entry| entry.metadata().and_then(|m| m.modified()).ok());

    candidates
        .into_iter()
        .rev()
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                .contains(&bot_name.to_lowercase())
        })
        .map(|entry| entry.path().to_string_lossy().to_string())
}

fn tail_lines(path: &Path, max_lines: usize) -> Vec<String> {
    let Ok(raw) = fs::read_to_string(path) else {
        return vec![];
    };
    let mut lines = raw
        .lines()
        .rev()
        .take(max_lines)
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.reverse();
    lines
}

fn has_error_marker(line: &str) -> bool {
    let upper = line.to_ascii_uppercase();
    upper.contains("ERROR") || upper.contains("WARN") || upper.contains("FATAL")
}
