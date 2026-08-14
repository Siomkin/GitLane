use super::support::*;

#[test]
fn repo_selector_preserves_the_validated_authority_and_slug() {
    let repository = GithubRepository {
        host: "ghe.example.test:8443".into(),
        owner: "octo".into(),
        name: "app".into(),
    };
    assert_eq!(repo_selector(&repository), "ghe.example.test:8443/octo/app");
}
