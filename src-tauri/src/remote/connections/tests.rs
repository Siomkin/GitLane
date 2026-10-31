use super::*;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("gitlane-conn-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn conn(name: &str, host: &str, user: Option<&str>, port: Option<u16>) -> SshConnection {
    SshConnection {
        name: name.into(),
        host: host.into(),
        user: user.map(str::to_string),
        port,
        identity_file: None,
    }
}

#[test]
fn origins_are_normalised_through_the_locator() {
    assert_eq!(
        origin_of(&conn("w", "build.example", Some("me"), Some(2222))).unwrap(),
        "ssh://me@build.example:2222"
    );
    assert_eq!(
        origin_of(&conn("d", "devbox", None, None)).unwrap(),
        "ssh://devbox"
    );
    assert!(origin_of(&conn("x", "-oProxyCommand=x", None, None)).is_err());
}

#[test]
fn a_key_path_must_be_an_existing_file_that_cannot_read_as_an_option() {
    let tmp = TempDir::new("key");
    std::fs::create_dir_all(&tmp.0).unwrap();
    let key = tmp.0.join("id_test");
    std::fs::write(&key, "k").unwrap();
    assert!(identity_path("-oProxyCommand=x").is_err());
    assert!(identity_path("keys/id").is_err());
    assert!(identity_path(tmp.0.join("missing").to_str().unwrap()).is_err());
    assert_eq!(
        identity_path(key.to_str().unwrap()).unwrap(),
        key.to_str().unwrap()
    );
}

#[test]
fn the_form_key_wins_over_the_saved_one_and_no_key_means_no_arguments() {
    let tmp = TempDir::new("keyargs");
    let dir = tmp.0.as_path();
    std::fs::create_dir_all(dir).unwrap();
    let (saved, form) = (dir.join("id_saved"), dir.join("id_form"));
    std::fs::write(&saved, "k").unwrap();
    std::fs::write(&form, "k").unwrap();
    let args = |form_key: Option<&std::path::Path>| {
        key_args(
            dir,
            "ssh://devbox",
            form_key.map(|p| p.to_string_lossy().into()),
        )
        .unwrap()
    };
    assert!(args(None).is_empty());

    let mut saved_conn = conn("d", "devbox", None, None);
    saved_conn.identity_file = Some(saved.to_string_lossy().into());
    save(dir, None, &saved_conn).unwrap();
    assert_eq!(
        args(None),
        ["-i", saved.to_str().unwrap(), "-o", "IdentitiesOnly=yes"]
    );
    assert_eq!(args(Some(&form))[1], form.to_str().unwrap());
    assert_eq!(
        args(Some(std::path::Path::new("  ")))[1],
        saved.to_str().unwrap()
    );
}

#[test]
fn a_home_relative_key_is_expanded() {
    let Some(home) = home_dir() else { return };
    let Some(existing) = std::fs::read_dir(&home)
        .ok()
        .and_then(|mut d| d.find_map(|e| e.ok().filter(|e| e.path().is_file())))
    else {
        return;
    };
    let name = existing.file_name().into_string().unwrap();
    let expanded = identity_path(&format!("~/{name}")).unwrap();
    assert_eq!(expanded, home.join(&name).to_string_lossy());
}

#[test]
fn saving_round_trips_edits_and_refuses_a_second_connection_for_one_origin() {
    let tmp = TempDir::new("save");
    let dir = tmp.0.as_path();
    assert!(load(dir).is_empty());

    std::fs::create_dir_all(dir).unwrap();
    let key = dir.join("work_key");
    std::fs::write(&key, "k").unwrap();
    let mut work = conn("Work laptop", "build.example", Some("me"), None);
    work.identity_file = Some(format!(" {} ", key.display()));
    let saved = save(dir, None, &work).unwrap();
    assert_eq!(saved[0].identity_file.as_deref(), key.to_str());

    let err = save(dir, None, &conn("Again", "build.example", Some("me"), None)).unwrap_err();
    assert!(err.contains("Work laptop"), "{err}");

    // Editing the same origin replaces it rather than duplicating.
    let renamed = save(
        dir,
        Some("ssh://me@build.example"),
        &conn("Build box", "build.example", Some("me"), None),
    )
    .unwrap();
    assert_eq!(renamed.len(), 1);
    assert_eq!(
        for_origin(dir, "ssh://me@build.example").unwrap().name,
        "Build box"
    );

    assert!(delete(dir, "ssh://me@build.example").unwrap().is_empty());
}

#[test]
fn blank_names_and_port_zero_are_refused() {
    assert!(validate(&conn("  ", "devbox", None, None)).is_err());
    assert!(validate(&conn("d", "devbox", None, Some(0))).is_err());
}

#[test]
fn adding_a_connection_keeps_an_entry_this_version_cannot_parse() {
    let tmp = TempDir::new("keep");
    let dir = tmp.0.as_path();
    std::fs::create_dir_all(dir).unwrap();
    let odd = conn("Odd", "-not-a-host", None, None);
    std::fs::write(dir.join(FILE), serde_json::to_vec(&vec![odd]).unwrap()).unwrap();
    let saved = save(dir, None, &conn("Devbox", "devbox", None, None)).unwrap();
    assert_eq!(saved.len(), 2);
}
