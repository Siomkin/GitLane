//! Parsing `#[tauri::command]` signatures out of source text.
//!
//! Every audit in this folder needs the same thing — the name, thread
//! placement and parameter list of each command — and none needs a real Rust
//! parser to get it. Split from the audits so the facade stays under the size
//! ceiling (architecture-rules-rust.md §6).

/// One `#[tauri::command]` signature as parsed from source text — enough
/// shape for the contract audits (name, thread placement, parameter names)
/// without a Rust parser.
pub(super) struct CommandSig {
    pub(super) name: String,
    /// Declared `async fn` (the `blocking()` shape) rather than a plain `fn`.
    pub(super) is_async: bool,
    /// Parameter names in declaration order (`mut` stripped, types dropped).
    pub(super) params: Vec<String>,
    /// The declared type of each entry in `params`, same order. Kept so the
    /// argument-name audit can tell a user-supplied parameter (which the
    /// frontend must pass) from one Tauri injects (`AppHandle`, `State`,
    /// `Webview`), which never appears in the invoke payload.
    pub(super) param_types: Vec<String>,
    /// 1-based line of the `fn` item, for failure messages.
    pub(super) line: usize,
}

/// Every `#[tauri::command]` signature in `source`, in declaration order. The
/// signature runs from the `fn` line to its opening brace; further attributes
/// between `#[tauri::command]` and the `fn` are skipped.
pub(super) fn command_signatures(source: &str) -> Vec<CommandSig> {
    let lines: Vec<&str> = source.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() == "#[tauri::command]" {
            let mut j = i + 1;
            while j < lines.len() && lines[j].trim_start().starts_with("#[") {
                j += 1;
            }
            let mut sig = String::new();
            let mut k = j;
            while k < lines.len() {
                sig.push_str(lines[k]);
                sig.push('\n');
                if lines[k].contains('{') {
                    break;
                }
                k += 1;
            }
            out.push(parse_signature(&sig, j + 1));
            i = k;
        }
        i += 1;
    }
    out
}

fn parse_signature(sig: &str, line: usize) -> CommandSig {
    let (header, rest) = sig
        .split_once("fn ")
        .unwrap_or_else(|| panic!("no fn after #[tauri::command] at line {line}: {sig}"));
    let name = rest.split(['(', '<']).next().unwrap().trim().to_string();
    let open = rest
        .find('(')
        .unwrap_or_else(|| panic!("no parameter list for `{name}` at line {line}"));
    // The parameter list ends at the paren that balances the opening one;
    // `tauri::State<'_, X>` puts commas and angle brackets inside a type, so
    // both bracket kinds count toward nesting.
    let params_text = &rest[open + 1..];
    let mut depth = 0usize;
    let mut close = None;
    for (idx, c) in params_text.char_indices() {
        match c {
            '(' | '<' => depth += 1,
            ')' | '>' if depth == 0 => {
                close = Some(idx);
                break;
            }
            ')' | '>' => depth -= 1,
            _ => {}
        }
    }
    let params_text = &params_text[..close.unwrap_or(params_text.len())];
    let mut params = Vec::new();
    let mut param_types = Vec::new();
    let mut depth = 0usize;
    let mut current = String::new();
    for c in params_text.chars().chain(std::iter::once(',')) {
        match c {
            '(' | '<' => depth += 1,
            ')' | '>' => depth -= 1,
            ',' if depth == 0 => {
                if let Some((param, ty)) = current.split_once(':') {
                    let param = param.trim().trim_start_matches("mut ").trim();
                    if !param.is_empty() {
                        params.push(param.to_string());
                        param_types.push(ty.trim().to_string());
                    }
                }
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    CommandSig {
        name,
        is_async: header.contains("async"),
        params,
        param_types,
        line,
    }
}
