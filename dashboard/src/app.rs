use std::time::{Duration, Instant};

use anyhow::Result;
use crossterm::event::KeyCode;
use ratatui::widgets::ListState;

use crate::{actions::{self, DashboardAction, Risk}, state};

const DANGER_CONFIRM_TOKEN: &str = "DELETE";

#[derive(Clone, Copy, Debug)]
pub enum Tab {
    Overview,
    BotDetail,
    Scripts,
    Alerts,
}

impl Tab {
    pub fn title(self) -> &'static str {
        match self {
            Tab::Overview => "Overview",
            Tab::BotDetail => "Bot Detail",
            Tab::Scripts => "Scripts",
            Tab::Alerts => "Alerts",
        }
    }
}

#[derive(Debug)]
pub enum PendingAction {
    Confirm { action_index: usize },
    Danger { action_index: usize, typed: String },
}

#[derive(Debug)]
pub struct App {
    pub snapshot: state::Snapshot,
    pub selected_bot: usize,
    pub selected_action: usize,
    pub tab: Tab,
    pub last_output: String,
    pub actions: Vec<DashboardAction>,
    pub bot_list_state: ListState,
    pub action_list_state: ListState,
    pub pending_action: Option<PendingAction>,
    last_auto_refresh: Instant,
}

impl App {
    pub fn new() -> Result<Self> {
        let snapshot = state::load_snapshot()?;
        let actions = actions::dashboard_actions();

        let mut bot_list_state = ListState::default();
        if !snapshot.bots.is_empty() {
            bot_list_state.select(Some(0));
        }

        let mut action_list_state = ListState::default();
        if !actions.is_empty() {
            action_list_state.select(Some(0));
        }

        Ok(Self {
            snapshot,
            selected_bot: 0,
            selected_action: 0,
            tab: Tab::Overview,
            last_output: String::from("Ready."),
            actions,
            bot_list_state,
            action_list_state,
            pending_action: None,
            last_auto_refresh: Instant::now(),
        })
    }

    pub fn tick(&mut self) {
        if self.last_auto_refresh.elapsed() < Duration::from_secs(1) {
            return;
        }
        if let Err(err) = self.reload_snapshot(false) {
            self.last_output = format!("Auto-refresh failed: {err}");
        }
        self.last_auto_refresh = Instant::now();
    }

    pub fn refresh(&mut self) -> Result<()> {
        self.reload_snapshot(true)
    }

    fn reload_snapshot(&mut self, announce: bool) -> Result<()> {
        self.snapshot = state::load_snapshot()?;
        if self.snapshot.bots.is_empty() {
            self.selected_bot = 0;
            self.bot_list_state.select(None);
        } else {
            self.selected_bot = self.selected_bot.min(self.snapshot.bots.len() - 1);
            self.bot_list_state.select(Some(self.selected_bot));
        }
        if announce {
            self.last_output = String::from("Refreshed status data.");
        }
        Ok(())
    }

    pub fn next_bot(&mut self) {
        if self.snapshot.bots.is_empty() {
            self.selected_bot = 0;
            self.bot_list_state.select(None);
            return;
        }
        self.selected_bot = (self.selected_bot + 1) % self.snapshot.bots.len();
        self.bot_list_state.select(Some(self.selected_bot));
    }

    pub fn prev_bot(&mut self) {
        if self.snapshot.bots.is_empty() {
            self.selected_bot = 0;
            self.bot_list_state.select(None);
            return;
        }
        self.selected_bot = if self.selected_bot == 0 {
            self.snapshot.bots.len() - 1
        } else {
            self.selected_bot - 1
        };
        self.bot_list_state.select(Some(self.selected_bot));
    }

    pub fn next_action(&mut self) {
        if self.actions.is_empty() {
            self.selected_action = 0;
            self.action_list_state.select(None);
            return;
        }
        self.selected_action = (self.selected_action + 1) % self.actions.len();
        self.action_list_state.select(Some(self.selected_action));
    }

    pub fn prev_action(&mut self) {
        if self.actions.is_empty() {
            self.selected_action = 0;
            self.action_list_state.select(None);
            return;
        }
        self.selected_action = if self.selected_action == 0 {
            self.actions.len() - 1
        } else {
            self.selected_action - 1
        };
        self.action_list_state.select(Some(self.selected_action));
    }

    pub fn next_tab(&mut self) {
        self.tab = match self.tab {
            Tab::Overview => Tab::BotDetail,
            Tab::BotDetail => Tab::Scripts,
            Tab::Scripts => Tab::Alerts,
            Tab::Alerts => Tab::Overview,
        };
    }

    pub fn prev_tab(&mut self) {
        self.tab = match self.tab {
            Tab::Overview => Tab::Alerts,
            Tab::BotDetail => Tab::Overview,
            Tab::Scripts => Tab::BotDetail,
            Tab::Alerts => Tab::Scripts,
        };
    }

    pub fn handle_key(&mut self, code: KeyCode) -> Result<bool> {
        if self.pending_action.is_some() {
            return self.handle_pending_key(code);
        }

        match code {
            KeyCode::Char('q') => return Ok(true),
            KeyCode::Char('r') => self.refresh()?,
            KeyCode::Down | KeyCode::Char('j') => {
                if matches!(self.tab, Tab::Scripts) {
                    self.next_action();
                } else {
                    self.next_bot();
                }
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if matches!(self.tab, Tab::Scripts) {
                    self.prev_action();
                } else {
                    self.prev_bot();
                }
            }
            KeyCode::Right | KeyCode::Tab => self.next_tab(),
            KeyCode::Left => self.prev_tab(),
            KeyCode::Char('x') => self.run_selected_action()?,
            _ => {}
        }

        Ok(false)
    }

    pub fn run_selected_action(&mut self) -> Result<()> {
        if self.actions.is_empty() {
            self.last_output = String::from("No actions configured.");
            return Ok(());
        }

        self.selected_action %= self.actions.len();
        self.action_list_state.select(Some(self.selected_action));
        let action = &self.actions[self.selected_action];
        match action.risk {
            Risk::Safe => self.execute_action(self.selected_action)?,
            Risk::Confirm => {
                self.pending_action = Some(PendingAction::Confirm {
                    action_index: self.selected_action,
                });
            }
            Risk::Danger => {
                self.pending_action = Some(PendingAction::Danger {
                    action_index: self.selected_action,
                    typed: String::new(),
                });
            }
        }
        Ok(())
    }

    fn handle_pending_key(&mut self, code: KeyCode) -> Result<bool> {
        let Some(pending) = &mut self.pending_action else {
            return Ok(false);
        };

        match pending {
            PendingAction::Confirm { action_index } => match code {
                KeyCode::Char('y') | KeyCode::Char('Y') => {
                    let index = *action_index;
                    self.pending_action = None;
                    self.execute_action(index)?;
                }
                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                    self.pending_action = None;
                    self.last_output = String::from("Action cancelled.");
                }
                _ => {}
            },
            PendingAction::Danger { action_index, typed } => match code {
                KeyCode::Esc => {
                    self.pending_action = None;
                    self.last_output = String::from("Danger action cancelled.");
                }
                KeyCode::Backspace => {
                    typed.pop();
                }
                KeyCode::Enter => {
                    if typed == DANGER_CONFIRM_TOKEN {
                        let index = *action_index;
                        self.pending_action = None;
                        self.execute_action(index)?;
                    } else {
                        self.last_output = format!(
                            "Confirmation token mismatch. Type {DANGER_CONFIRM_TOKEN} and press Enter."
                        );
                    }
                }
                KeyCode::Char(c) => {
                    if c.is_ascii_alphanumeric() && typed.len() < DANGER_CONFIRM_TOKEN.len() {
                        typed.push(c.to_ascii_uppercase());
                    }
                }
                _ => {}
            },
        }

        Ok(false)
    }

    fn execute_action(&mut self, index: usize) -> Result<()> {
        if self.actions.is_empty() {
            return Ok(());
        }
        let action = &self.actions[index];
        match action.execute() {
            Ok(output) => {
                self.last_output = output;
                let _ = self.reload_snapshot(false);
            }
            Err(err) => {
                self.last_output = err.to_string();
            }
        }
        Ok(())
    }

    pub fn selected_bot(&self) -> Option<&state::BotStatus> {
        self.snapshot.bots.get(self.selected_bot)
    }
}
