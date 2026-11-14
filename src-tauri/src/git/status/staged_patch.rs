//! The whole staged diff as `git diff --staged` patch text, for an agent prompt.

use git2::{DiffFormat, DiffOptions};

use super::working::{head_tree, is_intent_to_add};
use crate::git::read::open;

/// HEAD-to-index patch text, or `None` when it would exceed `max_bytes` — the
/// caller then lets the agent read the diff itself rather than send a cut one.
/// Non-UTF-8 content is decoded lossily; the text is only ever read by a model.
pub fn staged_patch(path: &str, max_bytes: usize) -> Result<Option<String>, git2::Error> {
    let repo = open(path)?;
    let head = head_tree(&repo);
    let mut diff = repo.diff_tree_to_index(head.as_ref(), None, Some(&mut DiffOptions::new()))?;
    // Same rename detection as the staged list, so a move reads as one rename.
    diff.find_similar(None)?;
    let index = repo.index().ok();
    let mut bytes = Vec::new();
    let mut too_big = false;
    let printed = diff.print(DiffFormat::Patch, |delta, _, line| {
        // `git add -N` records an empty index entry that `git diff --staged` omits.
        let path = delta
            .new_file()
            .path()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        if is_intent_to_add(index.as_ref(), path) {
            return true;
        }
        if matches!(line.origin(), '+' | '-' | ' ') {
            bytes.push(line.origin() as u8);
        }
        bytes.extend_from_slice(line.content());
        too_big = bytes.len() > max_bytes;
        !too_big
    });
    if too_big {
        return Ok(None);
    }
    printed?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}
