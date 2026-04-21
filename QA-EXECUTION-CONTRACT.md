# QA 실행 계약 (QA Execution Contract)

이 문서는 Playwright 엔진이 시나리오 JSON을 결정론적으로 실행하기 위해 추가된 모든 구성 요소를 설명합니다.

---

## 추가된 파일 목록

```
config/
  qa-step-contract.json       ← 스텝 타입 실행 계약
  qa-matcher-registry.json    ← 어서션 매처 레지스트리
  qa-signal-registry.json     ← expectedSignal 관찰 계약
  qa-capture-kinds.json       ← capture 종류 레지스트리

src/core/qa/
  schemaVersion.js            ← 스키마 버전 호환성 검사
  runtimeContext.js           ← 런타임 변수 네임스페이스 관리
  locatorResolver.js          ← 엘리먼트 로케이터 결정론적 해석
  signalObserver.js           ← expectedSignals 관찰 엔진
  assertionExecutor.js        ← 매처 실행 엔진
  stepExecutor.js             ← 스텝 타입별 Playwright 실행기
  validator.js                ← 사전 실행 유효성 검사기
  reportBuilder.js            ← 실행 결과 리포트 조립기
  qaRunner.js                 ← QA 스위트 오케스트레이터

src/routes/
  qa.js                       ← POST /qa/run, POST /qa/validate 라우트

src/server.js                 ← QA 라우터 마운트 추가
```

---

## Part 1 — 스텝 타입 실행 계약 (`config/qa-step-contract.json`)

지원하는 12가지 스텝 타입과 각각의 실행 계약을 정의합니다.  
엔진은 이 목록에 없는 스텝 타입을 만나면 즉시 실행을 거부합니다.

| 스텝 타입 | Playwright 실행 메서드 | targetRef 필요 여부 |
|---|---|---|
| `goto` | `page.goto(url)` | 불필요 |
| `fill` | `locator.fill(value)` | 필요 |
| `click` | `locator.click()` | 필요 |
| `expect` | `assertionExecutor.run(assertion)` | 조건부 |
| `capture` | `locator.textContent()` 등 | 필요 |
| `scroll` | `page.evaluate(() => window.scrollBy())` | 불필요 |
| `scrollToElement` | `locator.scrollIntoViewIfNeeded()` | 필요 |
| `waitFor` | `locator.waitFor({ state })` | 조건부 |
| `select` | `locator.selectOption(value)` | 필요 |
| `check` | `locator.check()` | 필요 |
| `uncheck` | `locator.uncheck()` | 필요 |
| `press` | `locator.press(key)` 또는 `page.keyboard.press(key)` | 조건부 |

각 스텝 타입에는 다음이 정의됩니다:
- `requiredFields` — 없으면 validator가 거부
- `optionalFields` — 없어도 기본값 적용
- `allowedSignals` — 이 스텝에서 사용 가능한 expectedSignal 목록
- `navigates` — 내비게이션 발생 여부
- `autoCapturesPreClickState` — 클릭 전 aria/text 자동 스냅샷 여부

---

## Part 2 — 로케이터 해석 계약 (`src/core/qa/locatorResolver.js`)

엘리먼트 로케이터를 다음 우선순위로 결정론적으로 해석합니다.

### 해석 순서

```
1. analysisRef → nodeId로 분석 결과에서 엘리먼트 조회
   → 해당 노드의 locators[] 배열을 우선순위 정렬
   → count() >= 1 인 첫 번째 로케이터 사용

2. locatorFallback → 선언 순서대로 시도
   → count() >= 1 인 첫 번째 로케이터 사용

3. 실패 → { method: "failed" } 반환
```

### 로케이터 종류 우선순위 (높음 → 낮음)

```
testId > role > label > placeholder > text > css > xpath
```

### resolutionResult 구조

모든 스텝 실행 결과에 로케이터 해석 메타데이터가 기록됩니다:

```json
{
  "resolutionResult": {
    "method": "analysisRef | locatorFallback | failed",
    "nodeId": "node-14",
    "locatorKind": "css",
    "locatorValue": "input.search_text",
    "wasFallbackUsed": false,
    "strictMatch": false,
    "resolvedElementCount": 1
  }
}
```

---

## Part 3 — 변수/런타임 데이터 계약 (`src/core/qa/runtimeContext.js`)

실행 중 사용되는 변수를 4개의 네임스페이스로 관리합니다.

| 네임스페이스 | 용도 | 수정 가능 | 리포트 포함 |
|---|---|---|---|
| `data.*` | 시나리오 입력값 (`scenario.data`) | 불가 (immutable) | 가능 |
| `credential.*` | 런타임 주입 인증 정보 | 불가 | **불가** (보안) |
| `captured.*` | capture 스텝이 저장한 값 | 가능 | 가능 |
| `runtime.*` | 엔진 내부 상태 (pre-click 스냅샷 등) | 엔진 전용 | 불가 |

### 변수 참조 문법

```
${keyword}            → data.keyword (하위 호환)
${data.keyword}       → 명시적 data 네임스페이스
${captured.before}    → 이전 capture 스텝이 저장한 값
${credential.user}    → 인증 정보 (리포트에 기록 안 됨)
```

---

## Part 4 — 어서션/매처 계약 (`config/qa-matcher-registry.json`)

등록된 12개의 매처만 사용할 수 있습니다. 미등록 매처는 `unsupported_matcher` 에러로 거부됩니다.

| 매처 | 대상 | 동작 |
|---|---|---|
| `toHaveURL` | page | URL에 value 문자열이 포함되는지 확인 |
| `toContainURL` | page | `toHaveURL`의 별칭 |
| `toBeVisible` | element | 엘리먼트가 뷰포트에 보이는지 확인 |
| `toBeHidden` | element | 엘리먼트가 숨겨져 있는지 확인 |
| `toHaveText` | element | textContent 가 value와 동일한지 확인 |
| `toContainText` | element | textContent 에 value가 포함되는지 확인 |
| `toHaveValue` | element | input 값이 value와 동일한지 확인 |
| `toHaveAttribute` | element | 지정 attribute 가 value와 동일한지 확인 |
| `toHaveCountGreaterThan` | element | 매칭 엘리먼트 수가 value 초과인지 확인 |
| `toChangeFromStored` | element | textContent가 `storedKey` 저장값과 달라졌는지 확인 |
| `textOrAriaStateChanged` | element | 텍스트 또는 aria 속성이 클릭 전 스냅샷과 달라졌는지 확인 |
| `toHaveScrollYLessThanOrEqual` | page | `window.scrollY <= value` 인지 확인 |
| `toSatisfyAny` | page | `value` 배열의 조건 중 하나 이상이 충족되는지 확인 |

---

## Part 5 — Capture 계약 (`config/qa-capture-kinds.json`)

`capture` 스텝에서 사용할 수 있는 10가지 캡처 종류가 정의됩니다.

```json
{
  "type": "capture",
  "capture": {
    "kind": "text | innerText | textContent | value | attribute | aria | screenshot | visible | url | scrollY",
    "attributeName": "aria-label",   // kind=attribute 일 때만 필요
    "saveAs": "myKey"                // runtime.captured.myKey 에 저장
  }
}
```

| kind | 대상 | Playwright 메서드 |
|---|---|---|
| `text` / `textContent` | element | `locator.textContent()` |
| `innerText` | element | `locator.innerText()` |
| `value` | element | `locator.inputValue()` |
| `attribute` | element | `locator.getAttribute(attributeName)` |
| `aria` | element | `el.getAttribute('aria-*')` 모음 |
| `screenshot` | element | `locator.screenshot()` |
| `visible` | element | `locator.isVisible()` |
| `url` | page | `page.url()` |
| `scrollY` | page | `page.evaluate(() => window.scrollY)` |

저장된 값은 `runtime.captured` 에 기록되고 이후 스텝에서 `${captured.myKey}` 로 참조하거나, `toChangeFromStored` 매처의 `storedKey` 로 사용할 수 있습니다.

---

## Part 6 — expectedSignals 계약 (`config/qa-signal-registry.json`)

스텝 액션 실행 **전**에 관찰 프로미스를 등록하고, 실행 **후**에 결과를 수집합니다.

| 신호 타입 | required | 관찰 방법 | 실패 시 스텝 블록 |
|---|---|---|---|
| `urlChanged` | ✅ | `page.waitForURL(url => url !== before)` | 예 |
| `urlChangedOptional` | ❌ | 동일 (타임아웃 무시) | 아니오 |
| `networkRequest` | ❌ | `page.waitForRequest(urlContains 필터)` | 아니오 |
| `domChanged` | ✅ | `MutationObserver` on `document.body` | 예 |
| `domChangedOptional` | ❌ | 동일 (타임아웃 무시) | 아니오 |
| `scrollChanged` | ❌ | `window.scrollY` 150ms 폴링 | 아니오 |
| `elementVisible` | ❌ | `locator.waitFor({ state: 'visible' })` | 아니오 |

---

## Part 7 — 스텝 결과 계약 (StepResult)

모든 스텝은 동일한 형태의 결과를 반환합니다:

```json
{
  "stepId": "step-2",
  "name": "검색 버튼 클릭",
  "type": "click",
  "status": "passed | failed | skipped | blocked | retried_then_passed | retried_then_failed",
  "startedAt": "2026-04-21T05:00:00.000Z",
  "finishedAt": "2026-04-21T05:00:01.230Z",
  "durationMs": 1230,
  "logs": ["..."],
  "error": null,
  "errorCode": null,
  "resolutionResult": { "method": "analysisRef", "wasFallbackUsed": false, ... },
  "capturedOutput": null,
  "assertionResult": null,
  "expectedSignalResults": [
    { "type": "urlChanged", "required": true, "observed": true, "passed": true }
  ],
  "artifacts": []
}
```

---

## Part 8 — 리포트 계약 (`src/core/qa/reportBuilder.js`)

### 시나리오 리포트 주요 필드

```json
{
  "reportVersion": "2.0",
  "runId": "uuid",
  "scenarioId": "11ST-HOME-SEARCH-001",
  "status": "passed | failed",
  "summary": {
    "totalSteps": 3,
    "passedSteps": 3,
    "failedSteps": 0,
    "retriedSteps": 0,
    "assertionPassedCount": 1,
    "assertionFailedCount": 0,
    "averageStepDurationMs": 820,
    "slowestStepId": "step-2",
    "fallbackLocatorUsageCount": 0,
    "errorClassification": {}
  },
  "capturedValues": { "billboardPageBefore": "1 / 5" },
  "humanNotes": ["Scenario ... completed successfully."]
}
```

### 스위트 리포트

`buildSuiteReport`는 모든 시나리오 결과를 집계합니다:
- `totalScenarios`, `passedScenarios`, `failedScenarios`, `passRate`
- 전체 `errorClassification` 요약

리포트는 `outputs/qa-runs/{runId}/` 에 저장됩니다:
- `suite-report.json` — 스위트 전체 결과
- `{scenarioId}.json` — 시나리오별 상세 결과

---

## Part 9 — 에러 분류 계약

모든 실패에는 다음 중 하나의 `errorCode`가 부여됩니다:

| 코드 | 원인 |
|---|---|
| `target_not_found` | 로케이터 해석 실패 |
| `target_not_visible` | 엘리먼트가 숨겨져 있거나 비활성 |
| `timeout` | Playwright 타임아웃 초과 |
| `assertion_failed` | 매처 조건 불충족 |
| `navigation_blocked` | 안전 정책이 외부 내비게이션 차단 |
| `out_of_scope` | 안전 정책 플래그에 의해 스텝 거부 |
| `auth_required` | 인증이 필요한 페이지 |
| `context_destroyed` | 브라우저 컨텍스트 예기치 않은 종료 |
| `render_unstable` | 페이지 렌더링 불안정 |
| `modal_blocked` | 모달이 타겟 엘리먼트 접근 차단 |
| `capture_failed` | 캡처 실행 오류 |
| `unsupported_step` | 미등록 스텝 타입 |
| `unsupported_matcher` | 미등록 매처 이름 |

---

## Part 10 — 유효성 검사 계약 (`src/core/qa/validator.js`)

실행 전 스위트 JSON을 엄격하게 검증합니다. `valid === false` 이면 브라우저를 열지 않습니다.

검증 항목:
- 스키마 버전 호환성 (major 버전 불일치 시 즉시 거부)
- 지원하지 않는 스텝 타입
- 스텝 타입별 필수 필드 누락
- 미등록 매처 이름
- 미등록 캡처 kind
- 미등록 expectedSignal 타입
- `${변수}` 참조가 `scenario.data` 또는 유효한 네임스페이스를 사용하는지
- `timeoutMs` 가 양수인지
- `scroll.direction` 이 유효한지 (`up | down | left | right`)

---

## Part 11 — 안전 정책 계약

`suite.defaults.safety` 에 선언된 플래그를 실행 전에 강제 적용합니다:

| 플래그 | 기본값 | 설명 |
|---|---|---|
| `allowExternalNavigation` | `false` | `baseURL`과 다른 호스트로 goto 차단 |
| `allowFileUpload` | `false` | 파일 업로드 관련 액션 차단 |
| `allowDestructiveAction` | `false` | 파괴적 액션 차단 |
| `allowSensitiveAuthAction` | `false` | 민감한 인증 플로우 차단 |

위반 시 `errorCode: "out_of_scope"` 또는 `"navigation_blocked"` 로 스텝 실패 처리됩니다.

---

## API 엔드포인트

서버 시작 후 두 개의 QA 전용 엔드포인트가 추가됩니다:

### `POST /qa/validate` — 유효성 검사만 수행 (브라우저 미실행)

**요청:**
```json
{ "suite": { ...scenarioSuiteJSON } }
```

**응답:**
```json
{ "valid": true, "errors": [], "warnings": [] }
```

---

### `POST /qa/run` — 스위트 전체 실행

**요청:**
```json
{
  "suite":          { ...scenarioSuiteJSON },
  "analysisReport": null,
  "scenarioIds":    ["11ST-HOME-SEARCH-001"],
  "credentials":    {},
  "headless":       true,
  "stopOnFailure":  true
}
```

- `analysisReport` 생략 시: `analysisContext.analysisJobId` 로 `outputs/` 에서 자동 탐색
- `scenarioIds` 생략 시: 스위트 전체 실행

**응답:**
```json
{
  "status":     "passed",
  "runId":      "uuid",
  "outputPath": "outputs/qa-runs/{runId}/",
  "suiteReport": { ... }
}
```

**유효성 검사 실패 시 (HTTP 422):**
```json
{
  "status":           "validation_failed",
  "error":            "Scenario suite validation failed:\n...",
  "validationErrors": ["[scenario S1] step[step-1] Unsupported step type: ..."],
  "warnings":         []
}
```

---

## 전체 실행 흐름

```
POST /qa/run
    │
    ├─ 1. validateSuite()          ← valid === false 이면 422 반환
    │
    ├─ 2. loadAnalysisReport()     ← outputs/{jobId}/ 에서 final-report.json 탐색
    │      └─ buildAnalysisElementMap()  ← nodeId → element 맵 생성
    │
    ├─ 3. chromium.launch()
    │
    └─ 4. 각 시나리오 반복
           │
           ├─ new RuntimeContext({ data, credentials })
           │
           ├─ preconditions 실행
           │   └─ executeStep()
           │
           ├─ steps 실행
           │   └─ executeStep()
           │       ├─ 안전 정책 검사
           │       ├─ resolveTarget()    ← analysisRef → fallback → failed
           │       ├─ SignalObserver.setup()   ← 액션 전에 관찰 시작
           │       ├─ handler[step.type]()     ← Playwright 실행
           │       └─ SignalObserver.collect() ← 관찰 결과 수집
           │
           └─ buildScenarioReport()
               └─ outputs/qa-runs/{runId}/{scenarioId}.json
```
