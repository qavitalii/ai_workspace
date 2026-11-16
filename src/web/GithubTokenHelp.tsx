export function GithubTokenHelp() {
  return (
    <p className="muted">
      <a
        href="https://github.com/settings/personal-access-tokens/new"
        target="_blank"
        rel="noopener noreferrer"
      >
        Create a GitHub token
      </a>
      . Choose the repository owner, then Only select repositories and select
      this project. Allow Contents and Pull requests: read/write for publishing.
      Generate the token and paste it here. Required for private repositories;
      optional for reading public repositories.
    </p>
  );
}
