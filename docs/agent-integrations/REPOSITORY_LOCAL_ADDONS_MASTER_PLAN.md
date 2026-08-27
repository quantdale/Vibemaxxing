# Repository-Local Add-ons Master Plan — Vibemaxxing

## Status

**PLANNING ONLY / IMPLEMENT IN A LATER SESSION**

Target repository: `quantdale/Vibemaxxing`  
Planning branch: `plan/repo-local-addons-2026-08-28`

## Repository assessment

Tote Electron workspace hub for web LLMs, native apps and CLI agents; it already creates/manages MCP bindings and workspace-scoped agent routing.

**Decision:** `RECOMMEND_MCP_TEST_TOOLING_PLUS_ELECTRON_DIAGNOSTICS`

This repo already manipulates MCP configuration, so before/after config backup and preservation tests are mandatory.

## Recommended additions

### 1. MCP Inspector — RECOMMEND

**Type:** Developer tool

**Why it fits:** Reference MCP debugging tool is a strong fit for validating Tote-generated MCP configurations, server handshakes and workspace binding behavior.

**Constraints:** Repository-local dev dependency/invocation only. Use fixtures/fake servers; never expose real provider secrets in Inspector captures.

### 2. Chrome DevTools MCP — RECOMMEND

**Type:** MCP

**Why it fits:** Useful for Electron renderer/webview diagnostics, performance, console/network inspection and complex workspace UI behavior.

**Constraints:** Development-only against isolated Tote profiles/local fixtures. It must not attach to a user's real authenticated LLM tabs by default.

## Explicitly not recommended

- Replacing Tote's existing MCP binding system
- Global MCP registry edits during tests
- Capturing real login cookies/tokens
- A generic filesystem MCP over every workspace

## Non-negotiable preservation rule

Implementation is **additive only**. Do not remove, disable, rename, replace, migrate, or silently rewrite any existing MCP, plugin, skill, agent configuration, test harness, editor integration, project-local command, or durable agent-state mechanism.

Before any implementation, inventory the complete tracked tree for integration surfaces, including:

- `.mcp.json`, `mcp.json`, `.vscode/mcp.json`, `.cursor/**`, `.claude/**`, `.opencode/**`, `opencode.json*`, `.pi/**`;
- `AGENTS.md`, `.agent/**`, project-local skills/plugins and their manifests;
- package manifests, lockfiles, workspace files and postinstall hooks;
- browser/mobile/editor automation config;
- CI workflows and scripts that launch external tools;
- documentation naming MCPs, skills, plugins, agent servers or credentials.

Search the whole repository rather than only these common paths. Record each discovered integration, scope, command, permissions, dependency source and current use.

### Merge-only law

If an existing config must be changed, merge into it. Never regenerate a minimal config that drops unknown keys. Existing entries are protected even when they look redundant. Removal requires a separate creator-approved task.

## Repository-local scope law

Use the narrowest supported scope:

1. repository-tracked configuration;
2. repository-local dev dependency/package;
3. repository-owned wrapper or launcher;
4. pinned ephemeral execution from repository cwd;
5. user/global installation only after separate explicit creator approval.

Do **not** automatically modify home-directory MCP registries, user-wide editor settings, global npm/pip/cargo packages, shell profiles, PATH, global browser profiles, or machine-wide agent settings.

If an add-on fundamentally cannot be made repository-local, stop that item and record `GLOBAL_SCOPE_BLOCKED`. Do not bypass this rule.

For remote documentation MCPs, the repository-local config entry itself is the scope boundary; do not add global registration merely because the endpoint is remote.

## Secrets, privacy and authority

Never commit credentials, API keys, tokens, cookies, auth state, private user data, device secrets, production evidence or protected local paths. Use environment-variable names only.

A development MCP/skill is an assistance surface unless this plan explicitly says otherwise. It does not inherit the repository's test, release, device, security, scientific or evidence authority.

## Upstream verification requirement

Before pinning any package/server:

1. verify the current canonical upstream and documentation;
2. confirm maintenance status and package/server identity;
3. inspect current security advisories;
4. confirm runtime/toolchain compatibility;
5. confirm repository-local launch/configuration;
6. pin a compatible version when local packages are used;
7. record why it adds value beyond existing tooling.

Do not blindly use `latest` in durable repository config.

## Implementation sequence

### Phase 0 — Reconcile repository truth

- Fetch current target branch without discarding newer legitimate work.
- Record exact HEAD and working-tree state.
- Read governance, active specs/OpenSpec and agent-state files.
- Re-evaluate this recommendation if the architecture changed.

### Phase 1 — Exhaustive existing-integration inventory

- Search the full tracked tree.
- Mark every pre-existing integration **PROTECTED**.
- Record commands, scopes, permissions and secrets boundaries.
- If a recommended tool already exists, verify/improve it rather than duplicating it.

### Phase 2 — Feasibility gate

For every recommended item answer:

- Does it solve a current problem?
- Can it be project-scoped?
- Does it duplicate a stronger existing harness?
- Does it introduce new write/network/device authority?
- Is its security posture acceptable at the pinned version?
- Can it be tested on local/synthetic data?

Reject any item that becomes net-negative and record `NOT_RECOMMENDED_AFTER_REVALIDATION`.

### Phase 3 — Minimal repository-local implementation

- Add only approved items.
- Prefer existing config formats.
- Use local dependencies/UPM packages/wrappers rather than global installs.
- Use least-privilege tool profiles.
- Keep credentials external.
- Make no unrelated refactors.

### Phase 4 — Configuration preflight

Where mechanically useful, add a fast check for duplicate IDs, missing local dependencies, unexpected global resolution, unsafe targets/permissions, embedded secret-like values and config drift.

Preflight must not contact protected environments or mutate real user data.

### Phase 5 — Functional validation

Exercise each integration only on the smallest safe local/synthetic target. Prove both intended capability and its negative boundary. Then run existing repository tests/build/validation relevant to touched files.

### Phase 6 — Preservation audit

Compare before/after integration inventory and prove zero removals, zero hidden global changes, zero secret leakage, zero unrelated dependency churn and zero weakening of existing authority.

### Phase 7 — Handoff

Record exact files, versions/endpoints, activation steps, repository scope mechanism, environment-variable names, test results, preservation proof and any blocked/rejected item.

## Acceptance criteria

- Final tooling matches the repository-specific recommendation after current-state revalidation.
- Every installed tool is repository-scoped; otherwise it is truthfully `GLOBAL_SCOPE_BLOCKED`.
- All existing MCPs/plugins/skills remain intact.
- No user-wide/global config mutation occurs automatically.
- No secrets/private data enter Git or tool artifacts.
- Existing product/runtime/test/release authority remains unchanged.
- The diff is bounded to integration configuration, local dev dependencies, tests/preflight and documentation.

## Next-session execution prompt

> Implement this `REPOSITORY_LOCAL_ADDONS_MASTER_PLAN.md` on `quantdale/Vibemaxxing`. First inventory and protect every existing MCP/plugin/skill and agent integration. Revalidate the recommendation against current repository truth and current upstream documentation/security advisories. Add only tools that remain useful and can be repository-scoped. Never silently fall back to global installation; use `GLOBAL_SCOPE_BLOCKED` instead. Keep secrets/private data external, preserve all existing execution/test/governance authority, validate on safe local/synthetic targets, run relevant repository gates, perform a before/after preservation audit, and commit only the bounded integration changes and evidence.
