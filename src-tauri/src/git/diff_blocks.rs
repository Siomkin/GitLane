//! Changed-line blocks inside one unified-diff hunk: the maximal runs of added
//! and removed lines between context lines, with the span each covers on both
//! sides. Shared by the per-difference read (`status::differences`) and the range
//! writes (`write::patch_staging::range`) so both agree on where a block sits.

/// Half-open line span `[start, end)` on one side of a diff. An empty span marks
/// a position: a change that sits before line `start` and occupies no line on
/// that side (a pure insertion seen from the old side, a pure deletion from the new).
pub(crate) type Span = (u32, u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Block {
    /// First and last line of the block within the hunk (inclusive).
    pub line_start: usize,
    pub line_end: usize,
    pub old: Span,
    pub new: Span,
}

/// First line number of one `-a,b` / `+c,d` side. A zero-count side names the
/// line *after which* the change sits, so its first line is one further on.
fn first_line(spec: &str) -> Option<u32> {
    let mut parts = spec.split(',');
    let start: u32 = parts.next()?.parse().ok()?;
    let count: u32 = match parts.next() {
        Some(count) => count.parse().ok()?,
        None => 1,
    };
    Some(if count == 0 { start + 1 } else { start })
}

fn first_lines(header: &str) -> Option<(u32, u32)> {
    let rest = header.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    Some((first_line(old)?, first_line(new)?))
}

/// Every block of the hunk with this `@@` header and these line kinds
/// (`"ctx"` / `"add"` / `"del"`, in display order).
pub(crate) fn hunk_blocks(header: &str, kinds: &[&str]) -> Result<Vec<Block>, String> {
    let (mut old, mut new) =
        first_lines(header).ok_or_else(|| "Could not parse hunk header".to_string())?;
    let mut blocks = Vec::new();
    let mut open: Option<Block> = None;
    for (index, kind) in kinds.iter().enumerate() {
        if *kind == "ctx" {
            blocks.extend(open.take());
            old += 1;
            new += 1;
            continue;
        }
        let block = open.get_or_insert(Block {
            line_start: index,
            line_end: index,
            old: (old, old),
            new: (new, new),
        });
        block.line_end = index;
        if *kind == "del" {
            old += 1;
            block.old.1 = old;
        } else {
            new += 1;
            block.new.1 = new;
        }
    }
    blocks.extend(open);
    Ok(blocks)
}

/// Whether two spans on the same side overlap. A position touches a span it
/// sits inside or at either edge of, so adjacent changes count as related: the
/// callers use this to decide what a change belongs to, and erring towards
/// "related" only ever disables an action or widens a refusal.
pub(crate) fn spans_touch(a: Span, b: Span) -> bool {
    if a.0 == a.1 || b.0 == b.1 {
        a.0 <= b.1 && b.0 <= a.1
    } else {
        a.0 < b.1 && b.0 < a.1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_carry_their_span_on_each_side() {
        // 1 ctx, replace line 2 with two lines, 3 ctx, delete line 4, 5 ctx.
        let kinds = ["ctx", "del", "add", "add", "ctx", "del", "ctx"];
        let blocks = hunk_blocks("@@ -1,5 +1,5 @@ fn x", &kinds).unwrap();
        assert_eq!(
            blocks,
            vec![
                Block {
                    line_start: 1,
                    line_end: 3,
                    old: (2, 3),
                    new: (2, 4)
                },
                Block {
                    line_start: 5,
                    line_end: 5,
                    old: (4, 5),
                    new: (5, 5)
                },
            ]
        );
    }

    #[test]
    fn insertion_into_an_empty_file_starts_at_line_one() {
        let blocks = hunk_blocks("@@ -0,0 +1,2 @@", &["add", "add"]).unwrap();
        assert_eq!(blocks[0].old, (1, 1));
        assert_eq!(blocks[0].new, (1, 3));
    }

    #[test]
    fn positions_touch_spans_at_their_edges_but_spans_need_overlap() {
        assert!(spans_touch((3, 3), (3, 5)));
        assert!(spans_touch((5, 5), (3, 5)));
        assert!(!spans_touch((6, 6), (3, 5)));
        assert!(spans_touch((4, 4), (4, 4)));
        assert!(!spans_touch((1, 3), (3, 5)));
        assert!(spans_touch((1, 4), (3, 5)));
    }
}
