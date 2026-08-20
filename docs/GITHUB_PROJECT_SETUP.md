# ForgeBot GitHub Project Setup

This document describes the recommended GitHub Issues, Milestones, and Projects setup for ForgeBot.

## 1. Project

Create one GitHub Project named:

**ForgeBot Development**

Use a Board layout as the main view.

### Status values

- Backlog
- Ready
- In Progress
- Review
- Blocked
- Done

### Custom fields

#### Type
Single select:

- Epic
- Story
- Task
- Bug
- Spike

#### Priority
Single select:

- P0 — Critical
- P1 — High
- P2 — Medium
- P3 — Low

#### Area
Single select:

- Core
- Review
- GitHub
- Plugins
- Jobs
- Repository
- Config
- Policy
- Observability
- Testing
- DX
- Docs

#### Size
Single select:

- XS
- S
- M
- L
- XL

## 2. Recommended views

### Current
Board grouped by Status.

Filter to the currently active milestone.

### Roadmap
Table view grouped by Milestone, then Type.

Show: Title, Status, Type, Priority, Size, Area, Milestone.

### Epics
Table view filtered to `Type = Epic`.

### By Area
Board or table grouped by Area.

### Bugs
Table filtered to `Type = Bug`.

### Research
Table filtered to `Type = Spike`.

## 3. Milestones

Create these repository milestones.

### M0 — Foundation

Goal: make the current architecture deterministic and ready for real product behavior.

Includes:
- job processing foundation
- existing config-error cleanup (#1)
- logging-context cleanup (#2)
- webhook-to-job processing

Exit criteria:
- normalized code-change events are processed through a queue abstraction
- plugin execution is outside HTTP transport code
- core logging/config behavior is predictable

### M1 — GitHub Review MVP

Goal: a real GitHub App installation can review a pull request and publish deterministic feedback.

Includes:
- GitHub App authentication
- installation-scoped GitHub client
- normalized pull-request review input
- review finding model
- deterministic reference review plugin
- review publishing

Exit criteria:
- install/configure ForgeBot for a test repository
- open/update a pull request
- ForgeBot receives the event
- ForgeBot builds review input
- ForgeBot runs a deterministic review plugin
- ForgeBot publishes review feedback back to GitHub

### M2 — Review Engine

Goal: turn the MVP pipeline into a useful extensible review engine.

Suggested scope:
- review orchestration and aggregation
- finding deduplication
- configurable severity thresholds
- repository-context selection
- review limits/budgets
- plugin execution policy
- first useful built-in review rules

### M3 — Plugin Platform

Goal: make ForgeBot genuinely extensible while preserving security boundaries.

Includes existing issue #3.

Suggested scope:
- normalized plugin input/output contract
- webhook plugin adapter
- self-hosted script plugin adapter
- plugin capability declaration
- execution policy and permissions
- plugin timeout/error isolation
- plugin author documentation

### M4 — AI Review

Goal: add provider-agnostic LLM-powered code review on top of the deterministic review engine.

Suggested scope:
- LLM provider abstraction
- prompt/input construction
- structured output validation
- token/context budgets
- model configuration
- AI finding conversion
- retries/fallback behavior
- security and prompt-injection boundaries

### M5 — Production Ready / v1.0

Goal: a stable self-hosted release suitable for public use and portfolio demonstration.

Suggested scope:
- persistent queue adapter
- retry/idempotency policy
- observability and metrics
- deployment packaging
- Docker Compose
- installation guide
- security documentation
- contributor guide
- release automation
- stable plugin API/versioning policy

## 4. Existing issues

Use these suggested metadata values.

### #1 Improve user-facing config validation errors
- Type: Task
- Priority: P1
- Area: Config
- Milestone: M0 — Foundation
- Size: S

### #2 Normalize plugin logging context in core runner
- Type: Task
- Priority: P1
- Area: Observability
- Milestone: M0 — Foundation
- Size: XS

### #3 Support custom plugins without installing npm packages
- Type: Epic
- Priority: P2
- Area: Plugins
- Milestone: M3 — Plugin Platform
- Size: XL

## 5. Newly created issue hierarchy

### M0 — Foundation

- #4 `[EPIC] Establish reliable job processing foundation`
  - #5 `[STORY] Execute jobs inline through a queue abstraction`
    - #6 `[TASK] Implement InlineJobQueue`
    - #7 `[TASK] Add InlineJobQueue success and failure tests`
  - #8 `[STORY] Process normalized code-change jobs`
    - #9 `[TASK] Define ProcessCodeChangeJob contract`
    - #10 `[TASK] Implement ProcessCodeChangeJobHandler`
    - #11 `[TASK] Add ProcessCodeChangeJobHandler tests`
  - #12 `[STORY] Route GitHub code-change webhooks through the job pipeline`
    - #13 `[TASK] Enqueue ProcessCodeChangeJob from GitHub webhook handler`
    - #14 `[TASK] Add webhook-to-job integration test`

### M1 — GitHub Review MVP

- #15 `[EPIC] Build GitHub App authentication and installation context`
  - #16 `[STORY] Configure GitHub App credentials safely`
    - #17 `[TASK] Model GitHub App environment configuration`
    - #18 `[TASK] Document GitHub App environment variables`
  - #19 `[STORY] Authenticate GitHub requests per installation`
    - #20 `[TASK] Extract GitHub installation ID into provider context`
    - #21 `[TASK] Implement GitHub installation token provider`
    - #22 `[TASK] Build installation-scoped GitHub client factory`

- #23 `[EPIC] Deliver the first end-to-end pull request review`
  - #24 `[STORY] Build normalized pull request review input`
    - #25 `[TASK] Define provider-agnostic ReviewInput types`
    - #26 `[TASK] Fetch pull request changed files through GitHub adapter`
  - #27 `[STORY] Represent review findings independently of GitHub`
    - #28 `[TASK] Define ReviewFinding and severity model`
    - #29 `[TASK] Add finding validation for file locations`
  - #30 `[STORY] Publish structured review findings to GitHub`
    - #31 `[TASK] Publish summary review findings as a pull request comment`
    - #32 `[TASK] Publish file-scoped findings as inline review comments`
  - #33 `[STORY] Add a deterministic built-in review plugin for MVP validation`
    - #34 `[TASK] Implement reference review plugin with predictable finding output`
  - #35 `[TASK] Add end-to-end fixture for pull request review pipeline`

## 6. Suggested execution order for the next weeks

Keep pull requests deliberately small. Ideally most tasks should map to one PR.

### Week 1 — job foundation

1. #6 Implement InlineJobQueue
2. #7 Add InlineJobQueue tests
3. #9 Define ProcessCodeChangeJob contract
4. #10 Implement ProcessCodeChangeJobHandler
5. #11 Add handler tests
6. #13 Enqueue from webhook handler
7. #14 Add webhook-to-job integration test
8. #2 Normalize plugin logging context
9. #1 Improve config errors if startup/config UX is touched

### Week 2 — GitHub App authentication

1. #17 Model runtime credentials
2. #18 Document credentials
3. #20 Extract installation ID
4. #21 Implement installation token provider
5. #22 Build installation-scoped client factory

### Week 3 — review domain

1. #25 Define ReviewInput
2. #26 Fetch changed files
3. #28 Define ReviewFinding
4. #29 Validate finding locations
5. #34 Implement reference review plugin

### Week 4 — visible MVP

1. #31 Publish summary findings
2. #32 Publish inline findings
3. #35 Add end-to-end fixture
4. Run a real test repository through the complete GitHub App flow
5. Document MVP demo/setup steps

## 7. Dependency map

```text
#6 InlineJobQueue
 └─> #7 tests

#9 ProcessCodeChangeJob
 └─> #10 handler
      └─> #11 tests

#6 + #9 + #10
 └─> #13 webhook enqueue
      └─> #14 integration test

#17 runtime GitHub App config
#20 installation context
 └─> #21 token provider
      └─> #22 GitHub client factory

#25 ReviewInput
#22 GitHub client
 └─> #26 changed files

#28 ReviewFinding
 └─> #29 validation

#25 + #28
 └─> #34 deterministic review plugin

#22 + #28
 └─> #31 summary publishing

#26 + #29 + #31
 └─> #32 inline publishing

#26 + #31 + #34
 └─> #35 end-to-end fixture
```

## 8. Working rules

- Prefer one small task per pull request.
- Stories should normally not be implemented directly; close them when their child tasks satisfy the acceptance criteria.
- Epics describe outcomes, not implementation details.
- Add `Depends on: #N` to an issue when work is genuinely blocked by another issue.
- Avoid fake dependencies created only to impose a preferred order.
- Keep spikes time-boxed and convert discoveries into separate implementation issues.
- Bugs discovered during implementation should become their own issues when they are not trivial fixes within the current task.
- Keep M0/M1 focused; do not pull AI, marketplace, cloud, or ForgeRepo-specific functionality into the MVP.

## 9. ForgeRepo boundary

ForgeBot and ForgeRepo remain independent products.

ForgeBot may eventually integrate with ForgeRepo through an optional adapter/plugin or stable external contract. ForgeBot must not reimplement ForgeRepo responsibilities such as repository graph management, affected-project calculation, build orchestration, caching, or dependency-boundary enforcement.

ForgeRepo must not depend on ForgeBot.
