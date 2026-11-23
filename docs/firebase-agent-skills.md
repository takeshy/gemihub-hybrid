# Firebase Agent Skills used by this project

Official installation guide:
https://firebase.google.com/docs/ai-assistance/agent-skills

Official source inspected for this implementation:
https://github.com/firebase/agent-skills

Source revision inspected: `99954a30898bb5ddc8152ee10e124dc3b4106bf7`.

Relevant skills:

- `firebase-basics`: CLI, authentication, project creation and configuration.
- `firebase-ai-logic-basics`: Web SDK, AI Logic provisioning and App Check.
- `firebase-remote-config-basics`: defaults, loading and template management.

The source checkout in `.firebase-agent-skills/` is a local reference and is
excluded from this repository. It does not mean that the Firebase plugin or
MCP server is installed or connected in the current agent session.

For the Codex app, install the official Firebase plugin and start a task with
it enabled. The official setup requires verifying the Firebase CLI,
authentication and MCP environment before proceeding with Firebase operations.
Use a newly created project for this clone, never the existing Gemihub project.

Before runtime validation, explicitly provision AI Logic in that new project:

```sh
npx -y firebase-tools@latest init ailogic --project <new-project-id>
```

Keep App Check debug tokens out of source control and public production builds.
Use a production attestation provider for the public demo. Firebase browser
configuration identifies the app; it does not replace App Check or authorization.
