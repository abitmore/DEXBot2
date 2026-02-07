use std::process::Command;

use anyhow::{anyhow, Result};

#[derive(Clone, Copy, Debug)]
pub enum Risk {
    Safe,
    Confirm,
    Danger,
}

impl Risk {
    pub fn label(self) -> &'static str {
        match self {
            Risk::Safe => "safe",
            Risk::Confirm => "confirm",
            Risk::Danger => "danger",
        }
    }
}

#[derive(Clone, Debug)]
pub struct DashboardAction {
    pub name: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    pub risk: Risk,
}

impl DashboardAction {
    pub fn execute(&self) -> Result<String> {
        let output = Command::new(self.command).args(self.args).output()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let risk = self.risk.label();

        if output.status.success() {
            let body = if stdout.trim().is_empty() {
                stderr.trim()
            } else {
                stdout.trim()
            };
            Ok(format!(
                "[{risk}] {}\n{}",
                self.name,
                body.trim_end_matches('\n')
            ))
        } else {
            Err(anyhow!(
                "[{risk}] {} failed (code {:?})\n{}",
                self.name,
                output.status.code(),
                stderr.trim().trim_end_matches('\n')
            ))
        }
    }
}

pub fn dashboard_actions() -> Vec<DashboardAction> {
    vec![
        DashboardAction {
            name: "Check Update Status",
            command: "bash",
            args: &["scripts/check-update.sh"],
            risk: Risk::Safe,
        },
        DashboardAction {
            name: "Validate Bots Config",
            command: "node",
            args: &["scripts/validate_bots.js"],
            risk: Risk::Safe,
        },
        DashboardAction {
            name: "Analyze Orders",
            command: "node",
            args: &["scripts/analyze-orders.js"],
            risk: Risk::Safe,
        },
        DashboardAction {
            name: "Analyze Repo",
            command: "node",
            args: &["scripts/analyze-git.js"],
            risk: Risk::Safe,
        },
        DashboardAction {
            name: "Create Bot Symlinks",
            command: "bash",
            args: &["scripts/create-bot-symlinks.sh"],
            risk: Risk::Confirm,
        },
        DashboardAction {
            name: "Clear Logs",
            command: "bash",
            args: &["scripts/clear-logs.sh"],
            risk: Risk::Danger,
        },
        DashboardAction {
            name: "Clear Orders",
            command: "bash",
            args: &["scripts/clear-orders.sh"],
            risk: Risk::Danger,
        },
        DashboardAction {
            name: "Clear All",
            command: "bash",
            args: &["scripts/clear-all.sh"],
            risk: Risk::Danger,
        },
    ]
}
