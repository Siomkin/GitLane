//! Mode enums for forge pull-request writes. They never cross IPC: the
//! commands convert the wire `bool`s once with the `from_*` constructors.

/// Whether a pull request merge also deletes its source branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchAfterMerge {
    Keep,
    Delete,
}

impl BranchAfterMerge {
    /// The choice the IPC `deleteBranch` flag names.
    pub fn from_delete_branch(delete: bool) -> Self {
        if delete { Self::Delete } else { Self::Keep }
    }
}

/// The state a review thread is set to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadResolution {
    Resolved,
    Unresolved,
}

impl ThreadResolution {
    /// The state the IPC `resolved` flag names.
    pub fn from_resolved(resolved: bool) -> Self {
        if resolved {
            Self::Resolved
        } else {
            Self::Unresolved
        }
    }
}

/// Whether a new pull request opens as a draft.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftState {
    Ready,
    Draft,
}

impl DraftState {
    /// The state `PrCreateInput.draft` names.
    pub fn from_draft(draft: bool) -> Self {
        if draft { Self::Draft } else { Self::Ready }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forge_mode_flags_map_to_their_enums() {
        use BranchAfterMerge as B;
        use DraftState as D;
        use ThreadResolution as T;
        assert_eq!(B::from_delete_branch(true), B::Delete);
        assert_eq!(B::from_delete_branch(false), B::Keep);
        assert_eq!(T::from_resolved(true), T::Resolved);
        assert_eq!(T::from_resolved(false), T::Unresolved);
        assert_eq!(D::from_draft(true), D::Draft);
        assert_eq!(D::from_draft(false), D::Ready);
    }
}
