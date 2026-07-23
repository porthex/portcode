//! Shared chat/event wire vocabulary used by the Codex projection and Phone Sync.
//!
//! Model execution intentionally does not live here: the bundled OpenAI Codex
//! app-server is Portcode's sole agent engine.

pub use portcode_sync::wire::{Block, ChatMessage, StreamEvent};

pub fn provider_name_for_model(model: &str) -> Result<&'static str, String> {
    let model = model.trim();
    let codex_model = model.starts_with("gpt-")
        || model.starts_with("codex-")
        || model.starts_with("openai-")
        || model
            .strip_prefix('o')
            .and_then(|tail| tail.chars().next())
            .is_some_and(|character| character.is_ascii_digit());
    if model.is_empty() || !codex_model {
        return Err("Select a Codex model before starting this conversation.".to_string());
    }
    Ok("openai")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_codex_engine_models_are_admitted() {
        assert_eq!(provider_name_for_model("gpt-5.6-terra").unwrap(), "openai");
        assert!(provider_name_for_model("claude-opus-4-8").is_err());
        assert!(provider_name_for_model(" ").is_err());
    }
}
