//! The model and config-option surface of `session/new`: which options an
//! adapter advertises, which one selects the model, and how a legacy
//! `base[effort]` pin maps onto them.

use super::super::{AcpConfigOption, AcpModel};
use serde_json::Value;

/// Select values on a `configOptions` entry (`value` / `name` / `description`).
pub(super) fn select_option_values(option: &Value) -> Vec<AcpModel> {
    let text = |value: &Value, path: &str| {
        value
            .pointer(path)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    option
        .get("options")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    Some(AcpModel {
                        id: entry.get("value")?.as_str()?.to_owned(),
                        name: text(entry, "/name"),
                        description: text(entry, "/description"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The `session/new` config option that selects a model, if the adapter has one.
/// Matched on `id`/`category` because both spellings appear in the wild.
pub(super) fn model_config_option(session: &Value) -> Option<&Value> {
    config_options(session).find(|option| {
        let field = |key: &str| option.get(key).and_then(Value::as_str);
        field("id") == Some("model") || field("category") == Some("model")
    })
}

/// Categories Settings should expose next to the model picker (ACP SHOULD).
const SETTINGS_CONFIG_CATEGORIES: &[&str] = &["thought_level", "model_config"];

/// `thought_level` / `model_config` select options from `session/new`.
pub(super) fn session_config_options(session: &Value) -> Vec<AcpConfigOption> {
    config_options(session)
        .filter_map(|option| {
            let category = option.get("category").and_then(Value::as_str)?;
            if !SETTINGS_CONFIG_CATEGORIES.contains(&category) {
                return None;
            }
            // Only `select` options are useful here; boolean needs a capability
            // we don't advertise yet.
            if option
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("select")
                != "select"
            {
                return None;
            }
            let id = option.get("id").and_then(Value::as_str)?.to_owned();
            let options = select_option_values(option);
            if options.is_empty() {
                return None;
            }
            Some(AcpConfigOption {
                id,
                name: option
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                category: category.to_owned(),
                current_value: option
                    .get("currentValue")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                options,
            })
        })
        .collect()
}

pub(super) fn config_options(session: &Value) -> impl Iterator<Item = &Value> {
    session
        .get("configOptions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// A live session's config option with `id`, if present.
pub(super) fn config_option_by_id<'a>(session: &'a Value, id: &str) -> Option<&'a Value> {
    config_options(session).find(|option| option.get("id").and_then(Value::as_str) == Some(id))
}

pub(super) fn thought_level_option(session: &Value) -> Option<&Value> {
    config_options(session)
        .find(|option| option.get("category").and_then(Value::as_str) == Some("thought_level"))
}

/// Whether `model` appears in the session's advertised model list (config
/// option values or `models.availableModels`). Legacy `base[effort]` pins count
/// when the base alone is listed — [`split_legacy_effort_pin`] handles those.
pub(super) fn model_advertised_by_session(session: &Value, model: &str) -> bool {
    if let Some(option) = model_config_option(session) {
        let values = select_option_values(option);
        if values.iter().any(|entry| entry.id == model) {
            return true;
        }
        let (base, _) = split_legacy_effort_pin(model, &values);
        if values.iter().any(|entry| entry.id == base) {
            return true;
        }
    }
    session
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .is_some_and(|list| {
            list.iter()
                .any(|entry| entry.get("modelId").and_then(Value::as_str) == Some(model))
        })
}

/// Split a legacy pin like `gpt-5.6-sol[low]` into a base model id + effort
/// when the session's model config option only lists bare ids. Cursor-style
/// ids (`name[effort=high,fast=true]`) are left alone — those adapters keep
/// the full id in the config option list.
pub(super) fn split_legacy_effort_pin(
    model: &str,
    values: &[AcpModel],
) -> (String, Option<String>) {
    if values.iter().any(|entry| entry.id == model) {
        return (model.to_owned(), None);
    }
    let Some((base, rest)) = model.split_once('[') else {
        return (model.to_owned(), None);
    };
    let effort = rest.strip_suffix(']').unwrap_or(rest);
    if effort.is_empty() || effort.contains('=') || !values.iter().any(|entry| entry.id == base) {
        return (model.to_owned(), None);
    }
    (base.to_owned(), Some(effort.to_owned()))
}

/// Replace `session.configOptions` with the complete list returned by
/// `session/set_config_option`, so dependent pins (effort after model) see the
/// post-change options rather than the original `session/new` snapshot.
pub(super) fn merge_config_options(session: &mut Value, result: &Value) {
    if let Some(options) = result.get("configOptions") {
        session["configOptions"] = options.clone();
    }
}
