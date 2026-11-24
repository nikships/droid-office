---
name: leaving-pr-comments
description: Format GitHub PR comments, review replies, and dismissal notes posted on the user's behalf. Use whenever posting a top-level PR comment, inline review comment, or review thread reply on GitHub.
user-invocable: false
---

# Leaving PR Comments

Prefix every agent-authored comment left on the user's behalf with this GitHub
note callout:

```md
> [!NOTE]
> 🤖 **<model> responding on behalf of <user>**

Actual comment starts here.
```

Use the verified public name of the model that wrote the comment from Droid's
runtime context (or `team_models` / `office_whoami` in Droid Office; for example
`Claude Opus 5.5`, `GPT-6.1 Sol`, or `Gemini 4 Carbon`), and the user's name or
GitHub login (`gh api user --jq .login`).

If the session does not expose a verified model name, write `Factory Droid`
instead of guessing a model.

Keep the attribution inside the `[!NOTE]` block and start the reply after a
blank line outside it. Start the attribution line with `🤖`. Omit horizontal
rules, Setext underlines, headings, signature footers, and duplicate
attributions.

Apply this format to top-level PR comments, inline review comments, replies to
bots or human reviewers, and written explanations posted before resolving or
dismissing a review thread. Leave it out of PR descriptions, commit messages,
and text the user explicitly asked to post verbatim without attribution.

## Writing the reply

- Lead with the conclusion.
- Cite the exact `file:line`, behavior, check output, or reproduction.
- Keep it concise and skip filler, canned thanks, and status narration.
- Separate verified facts from judgment.

## Posting safely from Droid

1. Scan the full comment, including quoted lines and attachment links, for
   secrets, tokens, internal URLs, and private user data before posting.
2. Write the Markdown body to a temporary file (`mktemp`) and pass
   `--body-file <file>` (`gh pr comment`, `gh pr review`) or `-F body=@<file>`
   (`gh api`), then remove the temporary file. Shell-quoting raw Markdown
   corrupts `> [!NOTE]` callouts, backticks, and blank lines.
3. Check `git remote -v` and pass `--repo <owner>/<repo>` explicitly when
   `origin` is a fork so comments never land on an upstream parent repository.
4. Confirm GitHub returned the comment or review URL before resolving the
   corresponding review thread.
