# Gemihub Hybrid workspace instructions

This is an independent submission clone of takeshy/gemihub-agent. The approved
scope and acceptance criteria are in specs/BUILD_HYBRID_AI.md.

- Never edit, commit to or push to the upstream repository. The owner has now
  authorized co-hosting on gemihub-dev: use a separate container and add only
  the new hybrid.gemihub.net route/DNS record; preserve the existing containers,
  routes, settings and data. Do not use git worktrees sharing upstream
  Git metadata. The local independent clone is the only editing target.
- The owner approved removing visitor BYOK from this clone; this supersedes
  inherited docs and the original brief's instruction to preserve its relay.
- Keep booking prices, availability, authorization, idempotency and confirmation
  under the existing deterministic code/MCP tools. Models do not establish them.
- Each shop assistant is grounded only in that shop's published facts.
- In-scope text inference must actually use Firebase AI Logic. Tools and
  history-dependent requests use cloud-only mode. Voice and admin are excluded.
- Consult the official Firebase Agent Skills before Firebase work. Record
  real-device evidence separately from mocked tests; never infer ON_DEVICE
  from the requested inference mode.
- The inherited infra/dev and apps/shop/infra deployment configurations refer
  to upstream resources. Never execute their deployment commands. Use the
  clone's separate infra/hybrid deployment and explicit project IDs.
- Preserve third-party license notices. Keep credentials, App Check debug
  tokens, Terraform state and real user/reservation data out of Git.
