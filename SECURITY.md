# Security policy

jev-autopilot lets an automated model and a Telegram chat steer a Claude Code session
that is running unattended. Treat a security problem in it as seriously as a problem
in your shell.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository ("Report a vulnerability" under the
Security tab), or email the maintainer at the address on their GitHub profile.
Include the plugin version, your Claude Code version, and steps to reproduce.

You should hear back within a week. Fixes ship as a new release with a CHANGELOG
entry; credit is given unless you ask otherwise.

## Supported versions

Only the latest release is supported. Claude Code's mods API can change between
releases, so also keep Claude Code current.

## What is in scope

- Anything that lets a chat other than the paired one steer a session, approve a
  held call, or pair.
- Anything that lets a repository you clone run code through the Firstmate
  integration without being a genuine Firstmate checkout.
- A bot token or API key reaching the decisions log, a toast, a Telegram message,
  a thrown error or the model's context.
- A tool call bypassing screening in a way the README's threat model says it
  should not.

## What is out of scope

- Whoever holds the paired Telegram chat is the owner by design; a stolen phone or
  Telegram account is a Telegram problem.
- A model with shell access can read any file the user can, including the secrets
  file. The README's threat model explains why the file is still worth it.
- Jev's judgement: a wrong verdict is a model-quality issue, not a vulnerability,
  unless it was reached by a bypass the plugin should have prevented.
