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

Found something broken? Open an issue with the
**[Bug report](https://github.com/porthex/portcode/issues/new?template=bug_report.yml)**
form. The form asks for the details that make Windows/WebView2 bugs reproducible
(Windows build, WebView2 runtime version, Portcode version, install method, and
whether a shell command or file write was involved). Filling these in up front
avoids slow back-and-forth.

## Feature requests

Use the
**[Feature request](https://github.com/porthex/portcode/issues/new?template=feature_request.yml)**
form. It includes a scope check against [`GOVERNANCE.md`](GOVERNANCE.md) so we can
quickly tell whether a request fits the open-source core or the reserved
commercial surface.

## Security vulnerabilities

**Do not** open a public issue for security problems. Report privately via GitHub
Private Vulnerability Reporting as described in [`SECURITY.md`](SECURITY.md).
Portcode runs shell commands and holds API keys, so responsible disclosure
matters.

## Contributing

Want to fix or build something yourself? Start with
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the dev setup, the Windows-specific
gotchas, and the pull-request workflow.
