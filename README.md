# playwright-dom-analyze

Playwright 기반 **Analyze Worker 로컬 검증기**.  
Spring API + Kafka 아키텍처에서 Analyze Worker가 수행할 업무를 로컬에서 시뮬레이션합니다.

---

## 아키텍처 배경

이 프로젝트는 다음과 같은 분산 크롤러 아키텍처의 **Analyze Worker 역할**을 로컬에서 검증합니다.

```
[ Spring REST API ]
       │  POST /crawl (URL enqueue)
       ▼
[ Kafka: analyze-topic ]
       │
       ▼
[ Analyze Worker ]  ← 이 저장소가 시뮬레이션하는 역할
   1. URL 수신
   2. 페이지 그래프 조회 → 재방문 여부 확인
   3. Phase 1: Playwright DOM 분석 (신규 페이지만)
   4. Phase 3: 다음 URL 후보 발견 + 도달 가능성 검사
   5. 페이지 그래프 업데이트
   6. 결과 아티팩트 저장
       │  enqueue_now 결정들
       ▼
[ Kafka: analyze-topic ] (현재는 소비하지 않음 — 로컬 아티팩트만 저장)
```

> **이 저장소는 Kafka, Spring, DB를 사용하지 않습니다.**  
> 완전한 로컬 환경에서 Analyze Worker 동작을 검증하는 프로토타입입니다.

---

## 단계별 구현 현황

| 단계 | 이름 | 상태 |
|---|---|---|
| Phase 1 | 정적 분석 + 동적 트리거 탐색 | ✅ 구현됨 |
| Phase 2 | VLM 기반 시맨틱 분석 | ⏳ 미구현 (향후 추가 예정) |
| Phase 3 | 다음 URL 후보 발견 + 도달 가능성 검사 | ✅ 구현됨 |
| Graph    | 페이지 그래프 (재방문 방지) | ✅ 구현됨 |

### Phase 2가 제외된 이유

Phase 2는 Vision-Language Model(VLM) API 연동이 필요합니다.  
Phase 1 출력물(스크린샷, 어노테이션 스크린샷, static.json, trigger-results/)은 Phase 2가 추가될 때 별도 리팩터링 없이 바로 소비할 수 있도록 구조화되어 있습니다.

---

## 페이지 그래프

### 역할

`data/page-graph.json` 파일에 분석된 페이지 정보를 노드-엣지 그래프로 영속 저장합니다.  
실행 간에 유지되어 **재방문 방지(no-revisit)** 규칙을 구현합니다.

### 페이지 식별 규칙

페이지 동일성은 **정확한 호스트명 + 정규화된 경로명**으로 판단합니다.

```
dedupKey = hostname + normalizedPath
```

- 쿼리 스트링과 프래그먼트(#)는 식별에 사용하지 않습니다.
- 동일 경로의 쿼리 변형(`/about`, `/about?tab=1`)은 같은 노드로 병합됩니다.
- `discoveredVariants` 배열에 관찰된 URL 변형이 모두 기록됩니다.

예시:
| URL | dedupKey |
|---|---|
| `https://example.com` | `example.com/` |
| `https://example.com/` | `example.com/` |
| `https://example.com/about` | `example.com/about` |
| `https://example.com/about?tab=1` | `example.com/about` |

### 재방문 방지 규칙

1. 입력 URL의 `dedupKey` 로 그래프에서 노드를 조회합니다.
2. 노드가 존재하고 `analyzed: true` 이면 **Phase 1을 실행하지 않고** 즉시 반환합니다.
3. 신규 페이지인 경우에만 브라우저를 실행합니다.

---

## currentPageStatus 어휘

| 값 | HTTP status | 의미 |
|---|---|---|
| `analyzed_new_page` | `done` | 신규 페이지 — Phase 1 + Phase 3 완료 |
| `skipped_existing_page` | `skipped` | 이전 실행에서 이미 분석됨 — 브라우저 미실행 |
| `stopped_out_of_scope` | `stopped` | `requestUrl`의 호스트가 `rootHost`와 불일치 |
| `stopped_redirect_out_of_scope` | `stopped` | 렌더 후 최종 URL이 `rootHost` 밖으로 이동 |

## 트리거 실행 결과 status 어휘

| 값 | 의미 |
|---|---|
| `success` | 트리거 실행 완료, DOM 변화 수집됨 |
| `failed` | 액션 중 예외 발생 |
| `navigated_away` | 클릭 후 페이지 URL이 변경됨 (로그인 리다이렉트 등) — 즉시 탈출하여 20초 낭비 방지 |

---

## 설치 및 실행

```bash
# 의존성 설치
npm install

# Playwright 브라우저 설치 (최초 1회)
npx playwright install chromium

# 서버 시작 (기본 포트: 3000)
npm run dev

# 포트가 이미 사용 중인 경우
PORT=3001 npm run dev
```

---

## API 사용법

**엔드포인트:** `POST /analyze`

### 요청 파라미터

| 필드 | 필수 | 설명 |
|---|---|---|
| `originalUrl` | ✅ 필수 | 탐색 범위를 정의하는 루트 URL. 이 URL의 호스트명이 `rootHost`가 됩니다. |
| `requestUrl` | 선택 | 이번 실행에서 분석할 페이지 URL. 생략 시 `originalUrl`과 동일하게 처리됩니다. |

**요청 본문 예시 — 루트 페이지 분석 (requestUrl 생략):**
```json
{ "originalUrl": "https://example.com" }
```

**요청 본문 예시 — 하위 페이지 분석:**
```json
{
  "originalUrl": "https://example.com",
  "requestUrl":  "https://example.com/about"
}
```

### 스코프 규칙

분석은 `originalUrl`의 **정확한 호스트명(`rootHost`)** 내에서만 허용됩니다.

```
originalUrl: https://naver.com
  requestUrl: https://naver.com/news       → ✅ 허용 (동일 호스트)
  requestUrl: https://shop.naver.com       → ❌ 중단 (서브도메인 불일치)
  requestUrl: https://m.naver.com          → ❌ 중단 (서브도메인 불일치)
  requestUrl: https://daum.net             → ❌ 중단 (다른 도메인)
```

Playwright가 페이지를 렌더링한 후 최종 URL도 동일하게 검사합니다.
서버 측 리다이렉트가 `rootHost` 바깥으로 이동하면 탐색을 중단합니다.

```
originalUrl: https://naver.com
  requestUrl: https://naver.com/login
  finalUrl(렌더 후): https://accounts.naver.com/...  → ❌ 중단 (리다이렉트 탈출)
```

### 응답 예시 — 신규 페이지 분석:
```json
{
  "jobId": "job-abc123",
  "status": "done",
  "originalUrl": "https://example.com",
  "requestUrl": "https://example.com/about",
  "rootHost": "example.com",
  "requestHost": "example.com",
  "currentPageStatus": "analyzed_new_page",
  "reason": "request URL is inside the original URL scope",
  "outputPath": "outputs/job-abc123",
  "summary": {
    "phase1": {
      "staticComponentCount": 12,
      "triggerCandidateCount": 5,
      "triggerExecutedCount": 4,
      "changedTriggerCount": 2,
      "navigatedAwayCount": 1,
      "autoDynamicRegionCount": 3,
      "triggerPerformance": {
        "triggerParallelismEnabled": true,
        "maxParallelTriggerWorkers": 4,
        "screenshotMode": "changedRegion",
        "triggerExecutionTotalMs": 8500,
        "averageTriggerDurationMs": 2125,
        "slowestTriggerDurationMs": 3200
      }
    },
    "phase3": { "discoveredUrlCount": 18, "filteredUrlCount": 9, "queueReadyCount": 6, "holdCount": 1 },
    "graphUpdate": { "inputNodeCreated": true, "candidateNodeCreated": 7, "graphEdgeCreatedCount": 7 }
  }
}
```

**응답 예시 — 이미 분석된 페이지 (재방문 방지):**
```json
{
  "jobId": "job-def456",
  "status": "skipped",
  "originalUrl": "https://example.com",
  "requestUrl": "https://example.com/about",
  "rootHost": "example.com",
  "requestHost": "example.com",
  "currentPageStatus": "skipped_existing_page",
  "reason": "page example.com/about was already fully analyzed on 2026-04-15T02:31:50.586Z",
  "outputPath": "outputs/job-def456",
  "summary": { "phase1": null, "phase3": null, "graphUpdate": { "graphNodeCreated": false, "graphNodeReused": true } }
}
```

**응답 예시 — 스코프 밖 요청:**
```json
{
  "jobId": "job-ghi789",
  "status": "stopped",
  "originalUrl": "https://naver.com",
  "requestUrl": "https://shop.naver.com/products",
  "rootHost": "naver.com",
  "requestHost": "shop.naver.com",
  "currentPageStatus": "stopped_out_of_scope",
  "reason": "request host shop.naver.com does not match root host naver.com",
  "outputPath": "outputs/job-ghi789",
  "summary": { "phase1": null, "phase3": null, "graphUpdate": null }
}
```

**curl 예시:**
```bash
# 루트 페이지 분석
curl -X POST http://localhost:3000/analyze \
  -H "Content-Type: application/json" \
  -d '{"originalUrl": "https://example.com"}'

# 하위 페이지 분석
curl -X POST http://localhost:3000/analyze \
  -H "Content-Type: application/json" \
  -d '{"originalUrl": "https://example.com", "requestUrl": "https://example.com/about"}'
```

---

## 출력 디렉터리 구조

```
outputs/
└── {jobId}/
    ├── baseline.png                 # 기본 스크린샷
    ├── baseline-annotated.png       # 어노테이션 스크린샷 (VLM 입력용)
    ├── static.json                  # 정적 DOM 노드 + 페이지 메타데이터
    ├── trigger-candidates.json      # 트리거 후보 목록 (자동 동적 영역 제외 후)
    ├── auto-dynamic-regions.json    # 감지된 자동 동적 영역 목록
    ├── trigger-results/             # 트리거별 실행 결과
    │   └── {triggerId}.json
    ├── next-queue.json              # Phase 3 큐 아티팩트 (enqueueDecision 포함)
    ├── graph-snapshot.json          # 이 잡 시점의 전체 그래프 스냅샷
    └── final-report.json            # 통합 분석 보고서

data/
└── page-graph.json                  # 실행 간 유지되는 페이지 그래프 (영속)
```

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | Express 서버 포트 |
| `MAX_TRIGGERS` | `10` | 실행할 최대 트리거 수 |
| `MAX_PARALLEL_WORKERS` | `4` | 동시 트리거 탐색 워커 수 (bounded worker pool) |
| `TRIGGER_SCREENSHOT_MODE` | `changedRegion` | 트리거 스크린샷 모드: `fullPage` \| `viewport` \| `changedRegion` \| `element` |
| `DETECT_AUTO_DYNAMIC` | `true` | 자동 동적 영역 감지 활성화. `false`로 설정 시 관찰 단계 생략 |
| `AUTO_DYNAMIC_OBSERVATION_MS` | `3000` | 패시브 뮤테이션 관찰 시간 (ms) |
| `AUTO_DYNAMIC_OVERLAP_THRESHOLD` | `0.3` | 자동 동적 영역 겹침 비율 임계값 (0~1) |
| `FREEZE_CSS_TRIGGERS` | `false` | `true`로 설정 시 트리거 실행 전 CSS 애니메이션 일시 정지 |
| `MAX_URLS` | `50` | 수집할 최대 URL 수 |
| `MAX_CHECKS` | `20` | 최대 프리플라이트 검사 수 |
| `NODE_MIN_TEXT` | `3` | DOM 노드 최소 텍스트 길이 |
| `NODE_MIN_AREA` | `200` | DOM 노드 최소 가시 면적 (px²) |
| `NODE_MIN_SCORE` | `3` | 일반 태그 품질 점수 임계값 |
| `DEBUG_NODES` | `false` | `true`로 설정하면 `filtered-node-debug.json` 저장 |

`.env.example` 파일을 `.env`로 복사하여 사용하세요.

---

## final-report.json 구조

```json
{
  "jobId": "string",
  "startedAt": "ISO 8601",
  "finishedAt": "ISO 8601",
  "currentPageStatus": "analyzed_new_page | skipped_existing_page | stopped_out_of_scope | stopped_redirect_out_of_scope",

  "input": {
    "originalUrl": "탐색 범위를 정의하는 루트 URL",
    "requestUrl":  "이번 실행에서 분석한 URL"
  },

  "scope": {
    "rootHost":            "example.com",
    "requestHost":         "example.com",
    "requestAllowed":      true,
    "finalRenderedHost":   "example.com",
    "finalRenderedAllowed": true,
    "stopReason":          null
  },

  "inputPage": {
    "requestUrl":       "https://example.com/about",
    "finalUrl":         "리다이렉트 후 최종 URL",
    "hostname":         "example.com",
    "normalizedPath":   "/about",
    "dedupKey":         "example.com/about",
    "nodeId":           "그래프 노드 UUID",
    "graphNodeCreated": true
  },

  "phase1": { "...Phase 1 상세 결과..." },

  "graphUpdate": {
    "inputNodeCreated":     true,
    "candidateNodeCreated": 7,
    "graphEdgeCreatedCount": 7,
    "totalGraphNodes": 8,
    "totalGraphEdges": 7
  },

  "candidateSummary": {
    "discoveredCandidateCount":  18,
    "allowedCandidateCount":     9,
    "uniquePathCandidateCount":  8,
    "preflightCheckedCount":     8,
    "queueReadyCount":           6,
    "skippedCandidateCount":     0,
    "heldCandidateCount":        1
  },

  "queueSummary": {
    "queueFile":      "outputs/{jobId}/next-queue.json",
    "queueReadyCount": 6,
    "holdCount":       1,
    "skippedCount":    0
  },

  "phase3": { "...Phase 3 상세 결과 + 전체 URL 결정 목록..." }
}
```

`stopped_*` 상태에서는 `phase1`(redirect 경우 부분 포함), `phase3`, `graphUpdate`, `candidateSummary`, `queueSummary`가 모두 `null`입니다.

---

## enqueueDecision 어휘

Phase 3에서 각 URL 후보에 부여되는 결정 값입니다.

| 값 | 의미 |
|---|---|
| `enqueue_now` | 신규 경로, 프리플라이트 통과 → 향후 분석 대기열에 추가 |
| `hold_auth_required` | 프리플라이트 결과 인증 필요 → 인증 획득 후 재시도 필요 |
| `hold_unreachable` | 프리플라이트 실패 (타임아웃, 403, 네트워크 오류 등) |
| `skip_already_analyzed` | 이전 실행에서 이미 완전히 분석된 경로 |
| `skip_existing_known_page` | 그래프에 알려진 경로이지만 아직 분석되지 않음 |
| `skip_duplicate_path` | 현재 분석 중인 페이지와 동일한 경로 |

> 모든 분류는 휴리스틱(heuristic)입니다. 코드 주석과 JSON 출력에 명시되어 있습니다.

---

## 알려진 제한 사항

- **재귀 크롤링 없음**: `next-queue.json`의 `enqueue_now` 항목은 로컬에서 소비되지 않습니다.
- **Phase 2 없음**: VLM 시맨틱 분석은 구현되지 않았습니다.
- **단일 요청 처리**: 서버는 동시에 하나의 분석만 실행하기를 권장합니다 (브라우저 리소스 제한).
- **트리거 상태 롤백 없음**: 각 트리거는 신선한 컨텍스트에서 재실행되어 격리됩니다.
- **인증이 필요한 트리거**: 로그인 페이지로 이탈하는 트리거는 `navigated_away`로 분류되며 콘텐츠 수집은 이루어지지 않습니다.
- **인증 자동화 없음**: 인증이 필요한 페이지는 `auth-rules.json`에 미리 저장된 `storageState`로만 재시도됩니다.
- **자동 동적 감지는 휴리스틱**: 클래스 키워드 + 뮤테이션 관찰 기반이므로 모든 케이스를 감지하지 못할 수 있습니다.
- **도달 가능성 분류는 휴리스틱**: HTTP 상태 코드 기반이므로 완전하지 않을 수 있습니다.

---

## 향후 확장 계획

1. **Phase 2 추가**: Phase 1 출력물을 VLM에 전달하는 레이어를 `runAnalysis.js`의 Phase 1과 Phase 3 사이에 삽입
2. **큐 소비 루프**: `next-queue.json`의 `enqueue_now` 항목을 순차 처리하는 로컬 워커 루프
3. **Kafka 연동**: Spring 환경의 `analyze-topic`으로 `enqueue_now` 결정을 발행
4. **그래프 시각화**: `data/page-graph.json`을 D3.js 또는 Gephi로 시각화

---

## 프로젝트 구조

```
project-root/
├── package.json
├── README.md
├── AGENTS.md
├── .env.example
├── config/
│   └── auth-rules.json          # 인증 규칙 설정
├── storage-states/              # storageState JSON 파일 (gitignore)
├── data/
│   └── page-graph.json          # 실행 간 유지되는 페이지 그래프 (gitignore)
├── src/
│   ├── server.js
│   ├── routes/
│   │   └── analyze.js
│   └── core/
│       ├── runAnalysis.js       # Analyze Worker 오케스트레이터
│       ├── browser.js
│       ├── annotate.js
│       ├── compare.js
│       ├── utils.js
│       ├── graph/
│       │   ├── graphModel.js    # 순수 그래프 데이터 모델
│       │   ├── graphStore.js    # 파일 I/O (page-graph.json)
│       │   └── graphUpdater.js  # 그래프 인플레이스 변경
│       ├── phase1/
│       │   ├── staticAnalysis.js
│       │   ├── triggerDiscovery.js       # 트리거 후보 수집 + 네비게이션 앵커 제거 + selectorHint 중복 제거
│       │   ├── triggerRunner.js          # 단일 트리거 실행 (스크린샷 모드 + 이탈 감지)
│       │   ├── parallelTriggerRunner.js  # 병렬 트리거 워커 풀 오케스트레이터
│       │   ├── autoDynamicDetector.js    # 패시브 자동 동적 영역 감지
│       │   └── mutationTracker.js
│       └── phase3/
│           ├── extractUrls.js
│           ├── normalizeUrl.js
│           ├── filterUrls.js
│           ├── reachabilityChecker.js
│           ├── authRuleEngine.js
│           └── buildQueue.js
└── outputs/                     # 잡별 분석 결과물 (gitignore)
```
