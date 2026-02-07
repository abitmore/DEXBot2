use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Tabs, Wrap},
    Frame,
};

use crate::{
    app::{App, PendingAction, Tab},
};

pub fn render(frame: &mut Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(10),
            Constraint::Length(10),
        ])
        .split(frame.size());

    render_tabs(frame, app, chunks[0]);
    render_main(frame, app, chunks[1]);
    render_bottom(frame, app, chunks[2]);

    if app.pending_action.is_some() {
        render_modal(frame, app);
    }
}

fn render_tabs(frame: &mut Frame, app: &App, area: Rect) {
    let titles = [Tab::Overview, Tab::BotDetail, Tab::Scripts, Tab::Alerts]
        .iter()
        .map(|tab| tab.title())
        .collect::<Vec<_>>();

    let selected = match app.tab {
        Tab::Overview => 0,
        Tab::BotDetail => 1,
        Tab::Scripts => 2,
        Tab::Alerts => 3,
    };

    let status = if app.snapshot.pm2_online {
        format!(
            "PM2 online | processes: {} | alerts: {}",
            app.snapshot.pm2_processes,
            app.snapshot.alerts.len()
        )
    } else {
        format!("PM2 offline | alerts: {}", app.snapshot.alerts.len())
    };

    let tabs = Tabs::new(titles)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(format!("DEXBot2 Dashboard | {status}")),
        )
        .select(selected)
        .style(Style::default().fg(Color::Gray))
        .highlight_style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD));

    frame.render_widget(tabs, area);
}

fn render_main(frame: &mut Frame, app: &mut App, area: Rect) {
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(30),
            Constraint::Percentage(40),
            Constraint::Percentage(30),
        ])
        .split(area);

    let bot_items = app
        .snapshot
        .bots
        .iter()
        .map(|bot| {
            let cfg = if bot.active { "active" } else { "inactive" };
            ListItem::new(format!(
                "{} [{}|{}] {}",
                bot.name, bot.runtime_status, cfg, bot.pair
            ))
        })
        .collect::<Vec<_>>();

    let bot_list = List::new(bot_items)
        .block(Block::default().borders(Borders::ALL).title("Bots"))
        .highlight_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
        .highlight_symbol("-> ");
    frame.render_stateful_widget(bot_list, columns[0], &mut app.bot_list_state);

    let detail_text = if let Some(bot) = app.selected_bot() {
        let log_path = bot
            .log_path
            .as_ref()
            .map(|p| p.as_str())
            .unwrap_or("(no log file)");
        let alert_hint = if app.snapshot.alerts.is_empty() {
            String::from("No active alerts")
        } else {
            format!("{}", app.snapshot.alerts[0])
        };
        format!(
            "Selected: {}\nPair: {}\nConfig active: {}\nRuntime: {}\nWarnings: {}\nLog: {}\n\nLive ingestion:\n- PM2 status: {}\n- Tail lines loaded: {}\n- Alerts: {}\n- Latest alert: {}",
            bot.name,
            bot.pair,
            bot.active,
            bot.runtime_status,
            app.snapshot.warnings,
            log_path,
            if app.snapshot.pm2_online { "yes" } else { "no" },
            bot.log_tail.len(),
            app.snapshot.alerts.len(),
            alert_hint
        )
    } else {
        String::from("No bot entries found in profiles/bots.json")
    };
    let detail = Paragraph::new(detail_text)
        .wrap(Wrap { trim: true })
        .block(Block::default().borders(Borders::ALL).title("Bot Detail"));
    frame.render_widget(detail, columns[1]);

    let action_items = app
        .actions
        .iter()
        .map(|action| ListItem::new(format!("{} ({})", action.name, action.risk.label())))
        .collect::<Vec<_>>();
    let actions_list = List::new(action_items)
        .block(Block::default().borders(Borders::ALL).title("Scripts"))
        .highlight_style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
        .highlight_symbol("-> ");
    frame.render_stateful_widget(actions_list, columns[2], &mut app.action_list_state);
}

fn render_bottom(frame: &mut Frame, app: &App, area: Rect) {
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);

    let output = Paragraph::new(format!(
        "{}\n\nKeys: q quit | r refresh | j/k move | tab switch tab | x run action",
        app.last_output
    ))
    .wrap(Wrap { trim: false })
    .block(Block::default().borders(Borders::ALL).title("Output"));
    frame.render_widget(output, columns[0]);

    let log_lines = app
        .selected_bot()
        .map(|b| {
            if b.log_tail.is_empty() {
                String::from("(no log lines loaded)")
            } else {
                b.log_tail.join("\n")
            }
        })
        .unwrap_or_else(|| String::from("(no bot selected)"));

    let logs = Paragraph::new(log_lines)
        .wrap(Wrap { trim: false })
        .block(Block::default().borders(Borders::ALL).title("Live Log Tail"));
    frame.render_widget(logs, columns[1]);
}

fn render_modal(frame: &mut Frame, app: &App) {
    let Some(pending) = &app.pending_action else {
        return;
    };

    let popup = centered_rect(70, 35, frame.size());
    frame.render_widget(Clear, popup);

    let body = match pending {
        PendingAction::Confirm { action_index } => {
            let action = &app.actions[*action_index];
            format!(
                "Action: {}\nRisk: confirm\n\nPress y to execute or n/esc to cancel.",
                action.name
            )
        }
        PendingAction::Danger { action_index, typed } => {
            let action = &app.actions[*action_index];
            format!(
                "Action: {}\nRisk: danger\n\nType DELETE and press Enter to continue.\nCurrent input: {}\nEsc cancels.",
                action.name, typed
            )
        }
    };

    let modal = Paragraph::new(body)
        .wrap(Wrap { trim: true })
        .block(
            Block::default()
                .title("Confirmation Required")
                .borders(Borders::ALL)
                .style(Style::default().fg(Color::White).bg(Color::Black)),
        );
    frame.render_widget(modal, popup);
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area);

    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(vertical[1])[1]
}
