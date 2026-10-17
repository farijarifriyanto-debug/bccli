# Security policy

## Supported versions

The current line (`0.4.x`) receives security fixes. The legacy `0.1.x` launcher is deprecated
on npm and unmaintained; the `0.4.0-beta.*` series gets fixes only through the next stable
release.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability.

Use GitHub's private reporting: [Report a vulnerability](https://github.com/farijarifriyanto-debug/bccli/security/advisories/new),
or the **Security** tab → *Report a vulnerability*. If that is unavailable to you, contact the
repository owner another way and say you have a security report.

Helpful details:

- affected version (`bccli --version`) and how it was installed (npm, installer script);
- operating system and Node.js version;
- what an attacker can do, and what they need for it (a crafted repo? a malicious MCP server?
  a pull request?);
- the smallest reproduction you can manage, plus logs or a terminal transcript.

## What counts as a vulnerability

In scope — anything that breaks the permission model or the user's trust in it:

- a tool running without the approval the permission mode requires;
- a cloned project, an `AGENTS.md`, a hook, a plugin, or an MCP server gaining access it
  should not have;
- secrets or credentials of the user being read or transmitted without an explicit decision;
- prompt-injection paths that turn model output into an unapproved action;
- command execution through argument handling, path handling, or the update/install path.

Usually out of scope — the model saying something wrong, a suggestion that would be unsafe if
the user approved it, or a missing feature. Those are normal issues: please open a public one.

## What to expect

This is a small project, so no formal SLA. We aim to acknowledge a report quickly, agree on a
fix window with you, and credit you in the release notes unless you prefer otherwise. Please
give us a reasonable amount of time to release a fix before going public.
