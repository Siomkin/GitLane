use super::*;
use std::cell::RefCell;

#[test]
fn a_session_that_never_connected_announces_no_end() {
    let announced = Announced::new();
    let id = announced.attempt();
    let mut ended = false;
    announced.ended("ssh://h", id, || ended = true);
    assert!(!ended);
}

#[test]
fn an_old_session_ending_late_does_not_end_the_new_one() {
    let announced = Announced::new();
    let old = announced.attempt();
    let new = announced.attempt();
    announced.connected("ssh://h", old, || {});
    announced.connected("ssh://h", new, || {});
    let events = RefCell::new(Vec::new());
    announced.ended("ssh://h", old, || events.borrow_mut().push("old"));
    announced.ended("ssh://h", new, || events.borrow_mut().push("new"));
    assert_eq!(events.into_inner(), vec!["new"]);
}

#[test]
fn the_end_is_announced_once_and_per_host() {
    let announced = Announced::new();
    let a = announced.attempt();
    let b = announced.attempt();
    announced.connected("ssh://a", a, || {});
    announced.connected("ssh://b", b, || {});
    let mut count = 0;
    announced.ended("ssh://a", a, || count += 1);
    announced.ended("ssh://a", a, || count += 1);
    assert_eq!(count, 1);
    let mut b_ended = false;
    announced.ended("ssh://b", b, || b_ended = true);
    assert!(b_ended);
}
