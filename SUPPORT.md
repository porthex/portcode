# Getting help with Portcode

Thanks for using Portcode! Please use the channel that matches what you need.

## Questions and "how do I…?"

Open a thread in **[GitHub Discussions](https://github.com/porthex/portcode/discussions)**.
Use Discussions for usage questions, configuration help, ideas, and to show what
you have built. There is no Discord or Slack at launch — keeping conversation in
Discussions makes answers searchable for the next person.

Before posting, a quick search of existing Discussions and
[issues](https://github.com/porthex/portcode/issues) often turns up an answer.

## Bug reports

Found something broken? You have two options:

- **[Quick bug report](https://github.com/porthex/portcode/issues/new?template=bug_quick.yml)** —
  two fields and you're done. Best when you just want to flag something fast.
- **[Detailed bug report](https://github.com/porthex/portcode/issues/new?template=bug_report.yml)** —
  asks for the Windows/WebView2 specifics (Windows build, WebView2 runtime
  version, Portcode version, install method, and whether a shell command or file
  write was involved). Slower to fill, but it makes tricky bugs reproducible and
  avoids back-and-forth.

## Feature requests

Have an idea? You have two options:

- **[Quick idea](https://github.com/porthex/portcode/issues/new?template=feature_quick.yml)** —
  describe it in a sentence or two.
- **[Detailed feature request](https://github.com/porthex/portcode/issues/new?template=feature_request.yml)** —
  includes a scope check against [`GOVERNANCE.md`](GOVERNANCE.md) so we can quickly
  tell whether a request fits the open-source core or the reserved commercial
  surface. Best for larger proposals.

## Security vulnerabilities

**Do not** open a public issue for security problems. Report privately via GitHub
Private Vulnerability Reporting as described in [`SECURITY.md`](SECURITY.md).
Portcode runs shell commands and holds API keys, so responsible disclosure
matters.

## Contributing

Want to fix or build something yourself? Start with
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the dev setup, the Windows-specific
gotchas, and the pull-request workflow.
