mod migrations;
mod probe;
mod storage;

use super::CommitAgentMessages;

fn action_instruction<'a>(messages: &'a CommitAgentMessages, id: &str) -> &'a str {
    &messages
        .ai_actions
        .iter()
        .find(|command| command.id == id)
        .unwrap_or_else(|| panic!("missing {id}"))
        .instruction
}
