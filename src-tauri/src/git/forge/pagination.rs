//! Shared bounded cursor pagination for GitHub GraphQL connections.

pub(super) struct CursorPage<T> {
    pub items: Vec<T>,
    pub has_more: bool,
    pub end_cursor: Option<String>,
}

pub(super) struct CursorPageCollection<T> {
    pub items: Vec<T>,
    pub truncated: bool,
}

pub(super) fn collect_cursor_pages<T, E>(
    max_pages: usize,
    mut fetch: impl FnMut(Option<&str>) -> Result<CursorPage<T>, E>,
) -> Result<CursorPageCollection<T>, E> {
    let mut items = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..max_pages {
        let page = fetch(cursor.as_deref())?;
        items.extend(page.items);
        if !page.has_more {
            return Ok(CursorPageCollection {
                items,
                truncated: false,
            });
        }
        let Some(next) = page.end_cursor else {
            return Ok(CursorPageCollection {
                items,
                truncated: true,
            });
        };
        cursor = Some(next);
    }
    Ok(CursorPageCollection {
        items,
        truncated: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_results_truncated_when_the_page_cap_is_hit() {
        let mut page = 0;
        let result = collect_cursor_pages(2, |_| {
            page += 1;
            Ok::<_, ()>(CursorPage {
                items: vec![page],
                has_more: true,
                end_cursor: Some(format!("cursor-{page}")),
            })
        })
        .expect("pagination should succeed");

        assert_eq!(result.items, vec![1, 2]);
        assert!(result.truncated);
    }

    #[test]
    fn marks_results_complete_when_the_connection_ends() {
        let result = collect_cursor_pages(2, |_| {
            Ok::<_, ()>(CursorPage {
                items: vec![1],
                has_more: false,
                end_cursor: None,
            })
        })
        .expect("pagination should succeed");

        assert_eq!(result.items, vec![1]);
        assert!(!result.truncated);
    }
}
