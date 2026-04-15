# AGENTS.md

## Project Overview

This repository is a local toy prototype for a webpage exploration engine built with Node.js and Playwright.

Current implementation scope:
- Phase 1: initial parsing and dynamic state exploration
- Phase 3: next URL discovery and reachability validation

Not implemented yet:
- Phase 2: VLM-based semantic analysis

Important:
Phase 2 must remain excluded for now.
However, all Phase 1 outputs must be saved in a VLM-friendly structure so that Phase 2 can be added later without major refactoring.

---

## Primary Goal

Given a URL, the system should:

1. Open the page with Playwright
2. Perform Phase 1 structural analysis
   - baseline DOM extraction
   - visible component grouping
   - annotated screenshots
   - trigger candidate discovery
   - sequential trigger execution
   - mutation tracking
   - changed region detection
3. Perform Phase 3 navigation discovery
   - extract navigable URLs
   - normalize and filter them
   - run reachability pre-flight checks
   - try storageState-based auth reuse if needed
   - produce a local next crawl queue artifact

This repository is a local prototype, not a full crawler platform.

---

## Tech Stack Rules

Use only the following unless the user explicitly changes the direction:
- Node.js 20+
- JavaScript
- ESM modules
- Playwright library
- Express
- fs/promises

Do not introduce by default:
- TypeScript
- Playwright Test
- Kafka
- Redis
- database
- React
- Next.js
- credential input UI
- cloud-specific dependencies

The project must run locally with:
- `npm install`
- `npm run dev`

---

## Current Scope

### In Scope
- URL input by HTTP API
- Phase 1 baseline page analysis
- visible DOM extraction
- static grouping
- annotated screenshots
- dynamic trigger discovery
- sequential trigger execution
- MutationObserver-based DOM change tracking
- changed region extraction
- Phase 3 URL extraction
- URL normalization and filtering
- reachability pre-flight checks
- local auth rule matching
- storageState reuse
- next-queue.json generation
- final-report.json generation

### Out of Scope
- Phase 2 VLM analysis
- LLM or VLM API integration
- QA scenario generation
- distributed crawling workers
- Spring integration
- Kafka producer or consumer
- Redis queue
- database persistence
- login form automation with credentials
- user account input UI
- production-grade crawler orchestration

---

## Project Structure

Keep the repository modular and close to this structure:

    project-root/
      package.json
      README.md
      AGENTS.md
      config/
        auth-rules.json
      storage-states/
      src/
        server.js
        routes/
          analyze.js
        core/
          runAnalysis.js
          browser.js
          annotate.js
          compare.js
          utils.js
          phase1/
            staticAnalysis.js
            triggerDiscovery.js
            triggerRunner.js
            mutationTracker.js
          phase3/
            extractUrls.js
            normalizeUrl.js
            filterUrls.js
            reachabilityChecker.js
            authRuleEngine.js
            buildQueue.js
      outputs/

Do not collapse everything into one file unless the user explicitly asks for it.

---

## API Contract

Main endpoint:

`POST /analyze`

Request body:

    {
      "url": "https://example.com"
    }

Response body shape:

    {
      "jobId": "string",
      "status": "done",
      "outputPath": "string",
      "summary": {
        "phase1": {
          "staticComponentCount": 0,
          "triggerCandidateCount": 0,
          "triggerExecutedCount": 0,
          "changedTriggerCount": 0
        },
        "phase3": {
          "discoveredUrlCount": 0,
          "filteredUrlCount": 0,
          "queueReadyCount": 0,
          "holdCount": 0
        }
      }
    }

Keep the API synchronous for now.

---

## Phase Responsibilities

### Phase 1 Responsibilities
Phase 1 is responsible for:
- opening the page in a fresh browser context
- waiting for rendering to settle
- capturing a baseline screenshot
- extracting baseline page metadata
- extracting visible DOM nodes only
- collecting bounding boxes and selector hints
- grouping static components into rough layout categories
- generating annotated screenshots
- extracting dynamic trigger candidates
- installing MutationObserver before trigger execution
- replaying each trigger in an isolated fresh context
- collecting mutations and changed regions
- saving trigger-level screenshots and JSON outputs

### Phase 3 Responsibilities
Phase 3 is responsible for:
- extracting navigable URLs from Phase 1 outputs and page metadata
- normalizing discovered URLs
- filtering unsupported or duplicate URLs
- classifying origin type such as same-origin, same-site, external
- running lightweight reachability checks
- heuristically classifying auth-required states
- matching local auth rules
- retrying with storageState where applicable
- building next-queue.json
- extending final-report.json with queue-ready results

### Phase 2 Boundary
Phase 2 must not be implemented now.
Do not add any semantic AI layer, VLM calls, prompt generation, or fake placeholder AI logic.
Only prepare outputs so that Phase 2 can later consume:
- screenshots
- annotated screenshots
- static JSON
- trigger result JSON

---

## Output Rules

All artifacts must be written under:

`outputs/{jobId}/`

Expected outputs include:
- `baseline.png`
- `baseline-annotated.png`
- `static.json`
- `trigger-candidates.json`
- `trigger-results/`
- `next-queue.json`
- `final-report.json`

All JSON outputs must be:
- serializable
- readable
- stable where possible
- useful for future VLM input
- free from DOM handles or Playwright handles

Prefer relative output paths inside reports when practical.

---

## Phase 1 Data Rules

For visible DOM node extraction, include serializable fields only:
- nodeId
- tagName
- text snippet
- role
- id
- class list
- href if present
- type if present
- bounding box
- visibility flags
- short selector hint

Do not store raw DOM elements in JSON.

Static grouping categories:
- header
- nav
- main
- section
- aside
- footer
- modal-like
- unknown

Trigger candidate examples:
- button
- a
- summary
- input[type=button]
- input[type=submit]
- role=button
- aria-expanded
- onclick
- tabIndex >= 0
- visible pointer-cursor elements

For trigger execution:
- prefer isolated fresh browser contexts
- do not attempt complicated DOM rollback
- re-enter the page instead of trying to undo state
- wrap each trigger action in try/catch
- continue execution even when one trigger fails

---

## Phase 3 Data Rules

URL extraction sources may include:
- `a[href]`
- `area[href]`
- `form[action]`
- metadata such as canonical and og:url
- URLs revealed after trigger execution
- safe navigation hints inferred from dynamic findings

URL filtering rules:
- allow only `http` and `https`
- exclude `mailto`, `tel`, `javascript`, `blob`, `data`
- remove duplicates after normalization
- skip common asset extensions unless explicitly needed

Reachability rules:
- prefer HEAD
- fallback to GET
- avoid unnecessary large response bodies
- use Playwright request capabilities, not axios

Reachability classification is heuristic.
Allowed classes:
- `reachable_now`
- `redirect_but_reachable`
- `auth_required`
- `blocked_or_unknown`
- `reachable_with_auth`
- `auth_rule_failed`
- `user_input_required`

These classifications must be clearly described as heuristic in code comments and JSON output.

---

## Auth Rule Engine Rules

Use local configuration from:

`config/auth-rules.json`

Supported behavior for now:
- match by origin
- match by login path patterns
- reuse existing storageState file
- create a fresh browser context with matched storageState
- rerun reachability check

Do not implement:
- interactive login
- real credential collection
- secret management
- account onboarding flow

If no matching auth rule exists, mark the target as requiring user input and do not fake a login solution.

---

## Playwright Usage Rules

Use Playwright library, not Playwright Test.

Preferred practices:
- use fresh browser contexts for isolation
- use `page.evaluate()` for DOM-side extraction
- install mutation tracking early through init script or equivalent
- keep selector hints practical and robust
- skip invisible or zero-sized nodes
- treat trigger execution as failure-prone and isolate it carefully

Do not over-optimize too early.
Reliability and clarity matter more than clever shortcuts in this repository.

---

## Coding Rules

General coding expectations:
- keep functions small
- keep modules focused
- use async/await
- favor readable code over heavy abstraction
- centralize config-like constants
- add clear console logs per phase
- use defensive try/catch around browser actions
- keep JSON schemas stable
- make URL normalization deterministic
- write code that is runnable locally without extra infrastructure

Do:
- extend existing modules before creating duplicate logic
- keep comments practical
- preserve backward compatibility where reasonable
- leave clean extension points for future Phase 2 integration

Do not:
- introduce speculative architecture
- add incomplete fake AI layers
- silently expand project scope
- add new infrastructure dependencies without clear necessity
- move Phase 3 logic into unrelated Phase 1 modules
- replace modular structure with a giant all-in-one file

---

## README Update Policy

If you change behavior, outputs, or API shape, update the README as well.

README should continue to explain:
- current scope is Phase 1 + Phase 3 only
- Phase 2 is intentionally excluded
- how to run locally
- sample API usage
- output directory structure
- known limitations
- future extension plan

---

## Change Policy for Agents

When modifying this repository:

1. Preserve scope boundaries
2. Do not implement Phase 2 unless explicitly requested
3. Keep outputs backward-compatible where practical
4. Prefer focused changes over broad rewrites
5. Reuse existing modules before creating new parallel logic
6. If JSON structure changes, update docs and examples
7. Keep the repository runnable after changes

---

## Success Criteria

A good contribution to this repository should:
- keep the project runnable locally
- improve Phase 1 or Phase 3 reliability
- keep outputs structured and stable
- preserve clean extension points for future Phase 2
- avoid unnecessary infrastructure expansion
- maintain clear boundaries between analysis, URL discovery, and auth retry logic