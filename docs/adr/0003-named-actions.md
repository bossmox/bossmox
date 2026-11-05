# ADR 0003: Writes go through named actions

Date: 2026-11-05. Status: accepted.

## Decision

Everything BossMox can change on Proxmox is a named entry in the `ACTIONS` table in `src/server.ts`. The browser asks for an action by name, such as `check-updates`. There is no general pass-through to the Proxmox API.

## Why

- The list of things BossMox can change is short, readable and easy to review.
- A bug or a malicious page can't turn BossMox into a proxy for any Proxmox call.
- Each action can carry its own validation and plain-language messages.

## Choices inside this

- Actions run as the signed-in person with their ticket and CSRF token, so Proxmox makes the permission decision. A 403 becomes a plain message.
- Long jobs return a Proxmox task ID. The page follows it through `/api/task`, which shows the log and the real result.
- Every action needs a confirmation that names the server or VM.
- An action is proven on the test server before it reaches a real server.

## Known limits

The confirmation lives in the browser. The server doesn't yet require proof that a person confirmed, because the custom-header and Origin checks stop other sites from calling actions directly.
