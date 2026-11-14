//! The whole staged diff as `git diff --staged` patch text, for an agent prompt.

use git2::{Delta, Diff, DiffDelta, DiffFormat};

use super::working::{head_tree, is_intent_to_add};
use crate::git::read::open;

/// HEAD-to-index patch text, or `None` when it would exceed `max_bytes` — the
/// caller then lets the agent read the diff itself rather than send a cut one.
/// Non-UTF-8 content is decoded lossily; the text is only ever read by a model.
pub fn staged_patch(path: &str, max_bytes: usize) -> Result<Option<String>, git2::Error> {
    let repo = open(path)?;
    let head = head_tree(&repo);
    let mut diff = repo.diff_tree_to_index(head.as_ref(), None, None)?;
    // `git add -N` records an empty index entry that `git diff --staged` omits.
    let index = repo.index().ok();
    let has_intent_to_add = index.as_ref().is_some_and(|ix| {
        ix.iter()
            .any(|e| std::str::from_utf8(&e.path).is_ok_and(|p| is_intent_to_add(Some(ix), p)))
    });
    // Same rename detection as the staged list, so a move reads as one rename —
    // except that an empty intent-to-add entry would pair with any deleted empty
    // file as a "rename" and hide the deletion.
    if !has_intent_to_add {
        diff.find_similar(None)?;
    }
    print_capped(&diff, Vec::new(), max_bytes, |delta| {
        let path = delta
            .new_file()
            .path()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        delta.status() == Delta::Added && is_intent_to_add(index.as_ref(), path)
    })
}

/// `diff` printed as patch text after `prefix`, skipping deltas `skip` names,
/// or `None` once the text would pass `max_bytes`.
pub(super) fn print_capped(
    diff: &Diff<'_>,
    prefix: Vec<u8>,
    max_bytes: usize,
    skip: impl Fn(&DiffDelta<'_>) -> bool,
) -> Result<Option<String>, git2::Error> {
    let mut bytes = prefix;
    let mut too_big = bytes.len() > max_bytes;
    if too_big {
        return Ok(None);
    }
    let printed = diff.print(DiffFormat::Patch, |delta, _, line| {
        if skip(&delta) {
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
