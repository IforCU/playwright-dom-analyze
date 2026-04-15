# playwright-dom-analyze — Developer Wiki

> **대상 독자:** 이 저장소를 처음 접하는 개발자, 기여자, 아키텍처 리뷰어  
> **작성 기준:** 2026-04-15 / Node.js 20+ / ESM / Playwright 1.44

---

## 목차

1. [서비스 개요](#1-서비스-개요)
2. [전체 파이프라인 흐름](#2-전체-파이프라인-흐름)
3. [Phase 1 — 정적 분석 + 동적 트리거 탐색](#3-phase-1--정적-분석--동적-트리거-탐색)
4. [Phase 2 — VLM 분석 (미구현)](#4-phase-2--vlm-분석-미구현)
5. [Phase 3 — URL 발견 + 도달 가능성 검사](#5-phase-3--url-발견--도달-가능성-검사)
6. [페이지 그래프](#6-페이지-그래프)
7. [Auto-Dynamic 감지 시스템](#7-auto-dynamic-감지-시스템)
8. [트리거 후보 필터링 규칙](#8-트리거-후보-필터링-규칙)
9. [병렬 트리거 워커 풀](#9-병렬-트리거-워커-풀)
10. [스크린샷 모드](#10-스크린샷-모드)
11. [출력 아티팩트 스키마](#11-출력-아티팩트-스키마)
12. [인증 규칙 엔진](#12-인증-규칙-엔진)
13. [스코프 제어](#13-스코프-제어)
14. [환경 변수 레퍼런스](#14-환경-변수-레퍼런스)
15. [모듈 맵](#15-모듈-맵)
16. [데이터 흐름 다이어그램](#16-데이터-흐름-다이어그램)
17. [Phase 2 확장 포인트](#17-phase-2-확장-포인트)
18. [자주 겪는 문제](#18-자주-겪는-문제)

---

## 1. 서비스 개요

`playwright-dom-analyze`는 **Analyze Worker 로컬 검증기**입니다.

실제 서비스 아키텍처에서 Analyze Worker는 Kafka 토픽에서 URL을 소비하고, Playwright로 페이지를 열어 DOM을 분석하고, 다음 탐색 URL을 발행합니다. 이 저장소는 그 동작을 **Kafka/Spring/DB 없이 로컬 HTTP API로 재현**합니다.

### 이 서비스가 하는 일

```
POST /analyze { originalUrl, requestUrl }
       │
       ▼
  스코프 검사 → 그래프 재방문 확인
       │
       ├─ 이미 분석됨 → skipped_existing_page 반환
       │
       └─ 신규 → Phase 1 → Phase 3 → 그래프 업데이트 → 아티팩트 저장
```

### 이 서비스가 하지 않는 일

- 재귀적으로 다음 URL을 크롤링하지 않습니다
- Kafka/Spring/DB를 사용하지 않습니다
- VLM 시맨틱 분석을 수행하지 않습니다 (Phase 2 예정)
- 로그인 폼을 자동으로 채우지 않습니다

---

## 2. 전체 파이프라인 흐름

```
[HTTP POST /analyze]
        │
        ▼
  ① 요청 파라미터 검증
     - originalUrl 필수, requestUrl 선택 (생략 시 originalUrl과 동일)
        │
        ▼
  ② 스코프 검사
     - requestHost === rootHost?
     - No → stopped_out_of_scope 즉시 반환
        │
        ▼
  ③ 그래프 재방문 확인
     - dedupKey (hostname + normalizedPath) 로 그래프 조회
     - analyzed: true → skipped_existing_page 반환
        │
        ▼
  ④ 브라우저 실행 (신규 페이지만)
        │
        ▼
  ⑤ PHASE 1
     a. 베이스라인 컨텍스트 생성 + MutationObserver 설치
     b. 페이지 로드 (load → networkidle 8s best-effort)
     c. 리다이렉트 스코프 재검사 (finalRenderedHost === rootHost?)
     d. 정적 DOM 노드 추출 + 품질 필터링
     e. 베이스라인 스크린샷 + 어노테이션 스크린샷
     f. Auto-Dynamic 감지 (3초 패시브 관찰)
     g. 트리거 후보 발굴 (순수 nav 앵커 제외, selectorHint 중복 제거)
     h. 병렬 트리거 탐색 (bounded worker pool)
     i. 각 트리거 결과 → trigger-results/{id}.json
        │
        ▼
  ⑥ 그래프 노드 업서트 (입력 페이지)
        │
        ▼
  ⑦ PHASE 3
     a. URL 추출 (a[href], form[action], 메타, 트리거 결과)
     b. 정규화 + 필터링 (동일 호스트, 경로 중복 제거)
     c. 그래프 대조 (신규 / 기분석 / 기알려짐 분류)
     d. 신규 후보만 프리플라이트 (HEAD → GET fallback)
     e. 인증 규칙 매칭 + storageState 재시도
     f. next-queue.json 생성
        │
        ▼
  ⑧ 그래프 업데이트 (후보 노드 + 엣지 업서트)
  ⑨ 노드 analyzed: true 마킹
  ⑩ 그래프 영속 저장 + 스냅샷
  ⑪ final-report.json 작성
        │
        ▼
  [HTTP Response]
```

---

## 3. Phase 1 — 정적 분석 + 동적 트리거 탐색

### 3-1. 정적 DOM 노드 추출 (`staticAnalysis.js`)

`page.evaluate()` 내부에서 실행. 각 노드에 대해:

| 필드 | 설명 |
|---|---|
| `nodeId` | 순번 기반 ID (`node-1`, `node-2`, ...) |
| `tagName` | 소문자 태그명 |
| `text` | textContent 최대 200자 |
| `role` | ARIA role |
| `bbox` | `getBoundingClientRect()` + scrollOffset |
| `group` | 레이아웃 카테고리 (header/nav/main/footer 등) |
| `selectorHint` | `#id` 또는 `tag.cls1.cls2` 형식 |

**품질 필터 (`scoreGenericNode`):**

- `HIGH_VALUE_TAGS` (input, button, a, select 등)는 점수 없이 통과
- `div/span/li/p` 같은 일반 태그는 점수 계산 → `NODE_MIN_SCORE` 미만이면 제거
- 텍스트 길이 < `NODE_MIN_TEXT`, 면적 < `NODE_MIN_AREA` 이면 제거

### 3-2. Auto-Dynamic 감지 (`autoDynamicDetector.js`)

트리거 후보 수집 **전**에 실행. 자세한 내용은 [7장](#7-auto-dynamic-감지-시스템) 참조.

### 3-3. 트리거 후보 발굴 (`triggerDiscovery.js`)

자세한 내용은 [8장](#8-트리거-후보-필터링-규칙) 참조.

### 3-4. 병렬 트리거 탐색 (`parallelTriggerRunner.js` + `triggerRunner.js`)

자세한 내용은 [9장](#9-병렬-트리거-워커-풀) 참조.

---

## 4. Phase 2 — VLM 분석 (미구현)

Phase 2는 아직 구현되지 않았습니다.  
삽입 위치: `runAnalysis.js`의 Phase 1과 Phase 3 사이.

Phase 1 출력물은 Phase 2가 바로 소비할 수 있는 구조로 설계되었습니다:

| 아티팩트 | Phase 2 활용 용도 |
|---|---|
| `baseline.png` | 전체 페이지 시각적 분석 |
| `baseline-annotated.png` | 컴포넌트 그룹 경계 레퍼런스 |
| `static.json` | DOM 구조 텍스트 컨텍스트 제공 |
| `trigger-results/*.json` | 상호작용 후 변화 영역 |
| 각 트리거의 `annotated.png` | 변경 영역 시각적 입력 |

---

## 5. Phase 3 — URL 발견 + 도달 가능성 검사

### 5-1. URL 추출 소스 (`extractUrls.js`)

- `a[href]` — 앵커 링크
- `area[href]` — 이미지맵
- `form[action]` — 폼 액션
- 메타 태그 — `canonical`, `og:url`
- 트리거 결과 — 트리거 실행 후 새로 나타난 DOM의 `a[href]`

### 5-2. 필터링 규칙 (`filterUrls.js`)

- `http` / `https` 프로토콜만 허용
- `mailto:`, `tel:`, `javascript:`, `blob:`, `data:` 제외
- 동일 호스트명만 허용 (서브도메인 불일치 제외)
- 경로 기반 중복 제거 (`dedupKey = hostname + normalizedPath`)
- `discoveredVariants` 배열에 쿼리 변형 기록

### 5-3. 그래프 대조 분류

| 분류 | 조건 |
|---|---|
| `new_candidate` | 그래프에 없는 경로 → 프리플라이트 실행 |
| `skip_already_analyzed` | `analyzed: true`인 기존 노드 |
| `skip_existing_known_page` | 그래프에 있지만 미분석 노드 |
| `skip_duplicate_path` | 현재 요청 URL과 동일한 경로 |

### 5-4. 프리플라이트 도달 가능성 분류

모든 분류는 **휴리스틱**입니다.

| 분류값 | 의미 |
|---|---|
| `reachable_now` | HEAD/GET 성공 |
| `redirect_but_reachable` | 3xx 후 도달 가능 |
| `auth_required` | HTTP 401/403 또는 로그인 페이지 휴리스틱 감지 |
| `blocked_or_unknown` | 타임아웃, 5xx, 네트워크 오류 등 |
| `reachable_with_auth` | auth-rules.json 매칭 + storageState 재시도 성공 |
| `auth_rule_failed` | storageState 재시도도 실패 |
| `user_input_required` | 매칭 규칙 없음 → 수동 처리 필요 |

### 5-5. enqueueDecision 어휘

| 값 | 의미 |
|---|---|
| `enqueue_now` | 신규 경로, 프리플라이트 통과 |
| `hold_auth_required` | 인증 필요 |
| `hold_unreachable` | 프리플라이트 실패 |
| `skip_already_analyzed` | 이미 분석된 경로 |
| `skip_existing_known_page` | 그래프에 알려진 경로 |
| `skip_duplicate_path` | 현재 페이지와 동일 경로 |

---

## 6. 페이지 그래프

### 역할

`data/page-graph.json`에 영속 저장.  
실행 간 유지되어 **재방문 방지(no-revisit)** 와 **상태 기반 분류**를 구현.

### 노드 식별 키

```
dedupKey = hostname + normalizedPath
```

쿼리 스트링과 Fragment(#)는 식별에 사용하지 않습니다.  
동일 경로의 URL 변형은 노드 내 `discoveredVariants` 배열에 누적됩니다.

### 노드 필드

| 필드 | 설명 |
|---|---|
| `nodeId` | UUID v4 |
| `dedupKey` | `hostname + normalizedPath` |
| `hostname` | 정확한 호스트명 |
| `normalizedPath` | 쿼리/프래그먼트 제거된 경로 |
| `representativeUrl` | 대표 URL |
| `analyzed` | 분석 완료 여부 |
| `analyzedAt` | 분석 완료 시각 |
| `discoveredVariants` | 관찰된 URL 변형 목록 |
| `reachabilityClass` | 프리플라이트 분류값 |
| `jobId` | 이 노드를 생성한 잡 ID |

### 엣지 필드

| 필드 | 설명 |
|---|---|
| `edgeId` | UUID v4 |
| `fromNodeId` | 발견한 페이지 노드 |
| `toNodeId` | 발견된 후보 노드 |
| `discoveredAt` | 발견 시각 |

---

## 7. Auto-Dynamic 감지 시스템

### 목적

네이버 메인 같은 포털 페이지에는 로테이팅 배너, 자동 슬라이드 캐러셀, 롤링 랭킹 위젯 등 **사용자 상호작용 없이 스스로 변하는 영역**이 있습니다. 이런 영역 내부의 버튼(이전/다음, 페이지네이션 점)을 트리거로 탐색하면:

- 결과가 수십 개의 `newNodes`를 반환하지만 전부 캐러셀 슬라이드 콘텐츠
- 유의미한 숨겨진 UI가 드러난 게 아닌 배경 노이즈

Auto-Dynamic 감지는 이 영역을 사전에 식별하여 트리거 탐색에서 제외합니다.

### 감지 단계

```
basePage 준비 완료
    │
    ▼
resetMutations()  ← 로딩 시 발생한 뮤테이션 초기화
    │
    ▼
아무 입력 없이 observationMs(기본 3000ms) 대기
    │
    ▼
getMutations()  ← 패시브 뮤테이션 수집
    │
    ▼
page.evaluate(_detectInPage)
  ├─ Pass 1: class/id 키워드 스캔
  │          (banner, carousel, slider, swiper, slick, rolling ...)
  ├─ Pass 2: aria-live / aria-atomic / aria-relevant 속성 스캔
  └─ Pass 3: 뮤테이션 타깃 집계 → ≥2회 변경된 요소 플래그
    │
    ▼
promoteToContainer()  ← 감지된 요소를 의미있는 크기의 부모로 승격
    │
    ▼
auto-dynamic-regions.json 저장
    │
    ▼
findTriggerCandidates(page, autoDynamicRegions)
```

### 키워드 목록 (기본값)

```
banner, carousel, slider, swiper, slick, rolling, promo,
autoplay, rotating, rotator, marquee, ticker,
mainvisual, main-visual, hero-visual, visualslide, visual-slide,
adslot, adsense, adroll
```

환경 변수로 커스터마이즈 불가능 (현재는 코드 수정 필요).

### overlapRatio 함수

```js
overlapRatio(candidateBbox, regionBbox)
// → 후보 bbox가 영역 bbox와 겹치는 비율 [0, 1]
// → AUTO_DYNAMIC_OVERLAP_THRESHOLD(기본 0.3) 초과 시 제외
```

트리거 후보 수집 시 + 트리거 실행 결과 newNodes 필터링 시 두 곳에서 사용됩니다.

---

## 8. 트리거 후보 필터링 규칙

### 8-1. 후보 수집 쿼리 (우선순위 순)

| 셀렉터 | 이유 | 기본 점수 |
|---|---|---|
| `[aria-expanded]` | 명시적 확장 가능 의도 | 5 |
| `[aria-haspopup]` | 팝업 표시 의도 | 5 |
| `summary` | detail/summary 위젯 | 4 |
| `button:not([disabled])` | 버튼 요소 | 3 |
| `[role="button"]` | 시맨틱 버튼 | 3 |
| `input[type="button/submit"]` | 입력 버튼 | 2 |
| `a[href]` | 앵커 (조건부, 아래 참고) | 2 |
| `[onclick]` | 인라인 onclick | 2 |
| `[tabindex]:not([tabindex="-1"])` | 키보드 포커스 가능 | 1 |

보너스 점수:
- `aria-expanded` 있으면 +2
- `aria-haspopup` 있으면 +2
- class에 `dropdown/toggle/collapse/menu/tab/accordion` 포함 시 +1
- 텍스트 내용 있으면 +1

### 8-2. 앵커 링크 인터랙티비티 필터

`a[href]`는 다음 중 **하나라도 해당하면** 후보에 유지:

| 조건 | 설명 |
|---|---|
| `href` 가 `#...`로 시작 | 인페이지 콘텐츠 공개 |
| `href` 가 비어있거나 없음 | 버튼처럼 사용되는 앵커 |
| `href` 가 `javascript:` | 인라인 스크립트 |
| `aria-expanded` 속성 있음 | 명시적 확장 의도 |
| `aria-haspopup` 속성 있음 | 팝업 의도 |
| `onclick` 속성 있음 | 클릭 핸들러 |
| `role="button"` | 버튼처럼 사용 |
| `data-toggle` / `data-bs-toggle` | Bootstrap 토글 |

**하나도 해당하지 않으면 제외됩니다.**  
→ 네이버의 `a.link_service` 12개, `a.link_partner` 13개 같은 순수 nav 링크는 모두 제거됩니다.

### 8-3. selectorHint 중복 제거

동일한 CSS 클래스 패턴 요소들은 대표 1개만 탐색합니다.

```
a.link_service (12개) → trigger-24 "메일" 1개만 유지
a.link_partner (13개) → 1개만 유지
```

예외: `a`, `button`, `input`, `div`, `span`, `li`, `p` 같은 제너릭 셀렉터는 중복 제거하지 않습니다 (같은 태그라도 기능이 다를 수 있으므로).

### 8-4. Auto-Dynamic 오버랩 제외

`overlapRatio(candidate.bbox, region.bbox) > 0.3` 이면 해당 후보를 제외하고 `region.excludedTriggerCount` 를 증가시킵니다.

---

## 9. 병렬 트리거 워커 풀

### 설계

```
candidates = [c1, c2, c3, ... cN]
nextIdx = 0

worker(slot):
  loop:
    myIdx = nextIdx++   ← 동기적 클레임 (Node.js 싱글스레드 — 뮤텍스 불필요)
    if myIdx >= N: break
    await runTrigger(browser, url, candidates[myIdx], outDir, opts)
    results[myIdx] = { ...raw, workerSlot, startedAt, finishedAt, durationMs }

await Promise.all([worker(0), worker(1), worker(2), worker(3)])
```

### 격리 보장

`runTrigger()` 내부에서 매번 `createFreshContext(browser)` 를 호출합니다.  
컨텍스트(쿠키, localStorage, DOM)는 트리거 간에 절대 공유되지 않습니다.

### 결과 순서

`results` 배열은 사전 할당 후 클레임된 인덱스에 기록되므로 완료 순서와 무관하게 **입력 후보 순서를 유지**합니다.

### navigated_away 즉시 탈출

클릭 후 `page.url() !== url` 이면 즉시 `navigated_away` 상태로 반환합니다.

```
기존: 이탈 후에도 2초 settle + 4초 domcontentloaded 대기 = 최대 ~20초
개선: URL 변경 감지 즉시 탈출 = ~200ms
```

---

## 10. 스크린샷 모드

| 모드 | Before | After | Annotated | 비용 |
|---|---|---|---|---|
| `fullPage` | fullPage | fullPage | DOM 오버레이 + fullPage | 최고 |
| `viewport` | 없음 | viewport | after 사본 | 빠름 |
| `changedRegion` | 없음 | viewport | **변경 노드 union bbox clip** | 기본, 권장 |
| `element` | 없음 | viewport | changedRegion과 동일 (예비) | 빠름 |

`changedRegion` 모드의 clip 계산:

```js
// 모든 newNodes의 bbox 합집합 + 24px 패딩
_computeUnionBbox(newNodes, 24)
// page.screenshot({ clip: unionBbox })
```

변화가 없으면 after 이미지를 annotated로 그대로 복사합니다.

---

## 11. 출력 아티팩트 스키마

### trigger-results/{triggerId}.json

```jsonc
{
  "triggerId": "trigger-10",
  "action": "click",
  "status": "success",           // success | failed | navigated_away
  "screenshotMode": "changedRegion",
  "beforeScreenshot": null,      // fullPage 모드가 아니면 null
  "afterScreenshot": "outputs/.../trigger-10-after.png",
  "annotatedScreenshot": "outputs/.../trigger-10-annotated.png",
  "mutationCount": 79,
  "mutations": [...],            // 최대 100개
  "newNodes": [...],             // auto-dynamic 오버랩 필터링 후, 최대 50개
  "backgroundNoiseCount": 109,   // 필터링으로 제거된 노드 수
  "newRegions": [...],
  "navigatedToUrl": null,        // navigated_away 시에만 값 있음
  "summary": "Detected 50 new node(s).",
  "startedAt": "2026-04-15T...",
  "finishedAt": "2026-04-15T...",
  "durationMs": 6980,
  "workerSlot": 0
}
```

### auto-dynamic-regions.json

```jsonc
{
  "detectionEnabled": true,
  "observationMs": 3000,
  "overlapThreshold": 0.3,
  "regionCount": 17,
  "regions": [
    {
      "bbox": { "x": 30, "y": 254, "width": 830, "height": 130 },
      "reasons": ["class_keyword_match"],    // 감지 근거
      "observedMutationCount": 0,
      "tagName": "div",
      "id": null,
      "classNames": ["main_carousel"],
      "excludedTriggerCount": 3              // 이 영역 때문에 제외된 후보 수
    }
  ]
}
```

`reasons` 가능한 값:
- `class_keyword_match` — class/id에 키워드 포함
- `aria_live_attribute` — aria-live/aria-atomic/aria-relevant 속성
- `passive_mutation` — 관찰 윈도우에서 ≥2회 변경

### phase1 summary (final-report.json 내부)

```jsonc
{
  "staticComponentCount": 12,
  "triggerCandidateCount": 11,   // auto-dynamic 제외 + selectorHint 중복 제거 후
  "triggerExecutedCount": 8,
  "changedTriggerCount": 5,
  "navigatedAwayCount": 2,       // 페이지 이탈로 즉시 탈출된 수
  "autoDynamicRegionCount": 17,
  "triggerPerformance": {
    "triggerParallelismEnabled": true,
    "maxParallelTriggerWorkers": 4,
    "screenshotMode": "changedRegion",
    "triggerExecutionTotalMs": 45000,
    "averageTriggerDurationMs": 5625,
    "slowestTriggerDurationMs": 12000
  }
}
```

---

## 12. 인증 규칙 엔진

### config/auth-rules.json 구조

```json
[
  {
    "origin": "https://www.naver.com",
    "loginPathPatterns": ["/login", "/nidlogin"],
    "storageStateFile": "storage-states/naver.json"
  }
]
```

### 동작 순서

1. 프리플라이트 결과가 `auth_required` 인 URL에 대해 실행
2. URL의 origin으로 규칙 매칭
3. 매칭 규칙의 `storageStateFile`로 신선한 컨텍스트 생성
4. 동일 URL 프리플라이트 재시도
5. 성공 → `reachable_with_auth`, 실패 → `auth_rule_failed`
6. 매칭 규칙 없음 → `user_input_required` (자동화 불가)

`storageState` 파일 생성은 이 시스템의 범위 밖입니다. 별도로 Playwright를 사용해 로그인한 후 `context.storageState({ path: '...' })` 로 저장하세요.

---

## 13. 스코프 제어

### originalUrl vs requestUrl

| 파라미터 | 역할 |
|---|---|
| `originalUrl` | 탐색 계보의 **루트**를 정의. 이 URL의 hostname이 `rootHost`가 됨 |
| `requestUrl` | 이번 실행에서 실제로 분석할 URL. 생략 시 `originalUrl`과 동일 |

### 두 번의 스코프 검사

```
1. 요청 시 검사: requestHost === rootHost?
   → No → stopped_out_of_scope (브라우저 실행 안 함)

2. 렌더 후 검사: finalRenderedHost === rootHost?
   → No → stopped_redirect_out_of_scope (브라우저 닫음)
```

두 번째 검사는 서버 측 리다이렉트가 다른 도메인으로 이동하는 경우를 처리합니다.  
예: `naver.com/login` → `accounts.naver.com/...`

---

## 14. 환경 변수 레퍼런스

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | HTTP 서버 포트 |
| `CHROME_PATH` | (자동 탐지) | Chrome 실행 파일 경로 |
| `MAX_TRIGGERS` | `10` | 탐색할 최대 트리거 후보 수 |
| `MAX_PARALLEL_WORKERS` | `4` | 동시 트리거 워커 수 |
| `TRIGGER_SCREENSHOT_MODE` | `changedRegion` | `fullPage\|viewport\|changedRegion\|element` |
| `DETECT_AUTO_DYNAMIC` | `true` | 자동 동적 영역 감지 활성화 |
| `AUTO_DYNAMIC_OBSERVATION_MS` | `3000` | 패시브 관찰 시간 (ms) |
| `AUTO_DYNAMIC_OVERLAP_THRESHOLD` | `0.3` | 겹침 비율 임계값 [0, 1] |
| `FREEZE_CSS_TRIGGERS` | `false` | 트리거 실행 전 CSS 애니메이션 일시 정지 |
| `MAX_URLS` | `50` | Phase 3 수집 최대 URL 수 |
| `MAX_CHECKS` | `20` | 프리플라이트 최대 실행 수 |
| `NODE_MIN_TEXT` | `3` | 정적 노드 최소 텍스트 길이 |
| `NODE_MIN_AREA` | `200` | 정적 노드 최소 가시 면적 (px²) |
| `NODE_MIN_SCORE` | `3` | 일반 태그 품질 점수 임계값 |
| `DEBUG_NODES` | `false` | `filtered-node-debug.json` 저장 |

---

## 15. 모듈 맵

```
src/
├── server.js                      진입점. Express 서버 + static 파일 서빙
├── routes/
│   └── analyze.js                 POST /analyze 라우터. jobId 생성, 응답 형식 변환
└── core/
    ├── runAnalysis.js             ★ 메인 오케스트레이터. 전체 파이프라인 조율
    ├── browser.js                 launchBrowser / createFreshContext / navigateTo
    ├── annotate.js                Playwright로 bbox 오버레이 어노테이션 스크린샷 생성
    ├── compare.js                 before/after 노드셋 비교 → newNodes / newRegions
    ├── utils.js                   jobOutputDir / toRelPath / sleep / writeJson
    │
    ├── graph/
    │   ├── graphModel.js          computePageIdentity / createNode / createEdge
    │   ├── graphStore.js          loadGraph / saveGraph / saveSnapshot
    │   └── graphUpdater.js        findNode / upsertNode / upsertEdge / markNodeAnalyzed
    │
    ├── phase1/
    │   ├── staticAnalysis.js      extractStaticNodes / getPageMeta / getPageLinks
    │   ├── triggerDiscovery.js    findTriggerCandidates (앵커 필터 + selectorHint 중복 제거)
    │   ├── triggerRunner.js       runTrigger (단일, 격리, 4가지 스크린샷 모드)
    │   ├── parallelTriggerRunner.js  runTriggersParallel (bounded worker pool)
    │   ├── autoDynamicDetector.js detectAutoDynamicRegions / overlapRatio / freezeCssAnimations
    │   └── mutationTracker.js     MUTATION_TRACKER_SCRIPT / installMutationTracker / getMutations
    │
    └── phase3/
        ├── extractUrls.js         extractUrls (정적 + 트리거 결과 URL 수집)
        ├── normalizeUrl.js        URL 정규화 (쿼리 제거, 경로 정규화)
        ├── filterUrls.js          filterUrls (호스트 필터 + 경로 중복 제거)
        ├── reachabilityChecker.js checkReachability (HEAD → GET, 분류 반환)
        ├── authRuleEngine.js      loadAuthRules / matchAuthRule / retryWithStorageState
        └── buildQueue.js          buildQueue (그래프 대조 + 결정 목록 생성)
```

---

## 16. 데이터 흐름 다이어그램

```
basePage (Playwright Page)
    │
    ├─→ getPageMeta()    ──────────────────────────────→ pageMeta
    ├─→ extractStaticNodes()  ────────────────────────→ allNodes (품질 필터 후)
    ├─→ getPageLinks()   ──────────────────────────────→ pageLinks (raw href 목록)
    │
    ├─→ detectAutoDynamicRegions()  ──────────────────→ autoDynamicRegions[]
    │                                                        │
    ├─→ findTriggerCandidates(page, autoDynamicRegions) ─────┘
    │       └── (앵커 필터 + selectorHint 중복 제거)
    │       └──→ candidates[]
    │
    └─→ [baseCtx.close()]

candidates[]
    │
    ▼
runTriggersParallel(browser, url, candidates, outDir, opts)
    ├── worker(0..3): runTrigger → { newNodes, mutations, backgroundNoiseCount, ... }
    └──→ triggerResults[]  +  triggerMetrics

triggerResults[]
    │
    ▼
extractUrls({ pageLinks, triggerResults, baseUrl })
    └──→ rawCandidates[]

rawCandidates[]
    │
    ▼
filterUrls(rawCandidates, { baseUrl, maxDiscoveredUrlsPerPage })
    └──→ filtered[]

filtered[]  +  graph
    │
    ▼
buildQueue({ candidates: filtered, sourceNodeId, jobId, ... })
    ├── graph 대조 분류 (신규 / 기분석 / 기알려짐)
    ├── checkReachability (신규만) + authRuleEngine
    └──→ queueDecisions[]  +  next-queue.json

queueDecisions[]
    │
    ▼
그래프 노드/엣지 업서트 → markNodeAnalyzed → saveGraph
    │
    ▼
final-report.json
```

---

## 17. Phase 2 확장 포인트

Phase 2를 추가할 때는 `runAnalysis.js`의 다음 주석 블록 위치에 삽입하면 됩니다:

```js
// ════════════════════════════════════════════════════════════════
// PHASE 3  —  URL discovery → graph-aware classification → pre-flight
//
// Phase 2 (VLM semantic analysis) is intentionally excluded here.
// Insertion point: between Phase 1 and this section.
// ════════════════════════════════════════════════════════════════
```

Phase 2에서 소비할 수 있는 데이터:

```js
// Phase 1 완료 후 사용 가능한 변수들
allNodes          // 정적 DOM 노드 배열
pageMeta          // 페이지 메타데이터
triggerResults    // 트리거 실행 결과 배열
baselinePng       // 베이스라인 스크린샷 경로
baselineAnnotatedPng  // 어노테이션 스크린샷 경로
// trigger-results/{id}-annotated.png 들도 접근 가능
```

---

## 18. 자주 겪는 문제

### Q: "Execution context was destroyed" 에러가 발생합니다

**원인:** 트리거 클릭이 페이지 이탈(로그인 리다이렉트 등)을 일으킴  
**해결:** 현재 코드는 `page.url() !== url` 감지 시 즉시 `navigated_away`로 탈출합니다. 에러가 계속 발생하면 `MAX_TRIGGERS` 를 줄이거나 해당 도메인의 auth-rule을 추가하세요.

### Q: 배너/캐러셀 영역 요소가 트리거 후보에 포함됩니다

**원인:** `DETECT_AUTO_DYNAMIC=false` 이거나, 해당 컨테이너의 class/id에 키워드가 없음  
**해결:**
1. `DETECT_AUTO_DYNAMIC=true` 확인
2. `AUTO_DYNAMIC_OBSERVATION_MS=5000` 으로 관찰 시간 증가
3. `autoDynamicDetector.js`의 `DEFAULT_AUTO_DYNAMIC_KEYWORDS`에 해당 키워드 추가

### Q: 네이버 같은 포털에서 타임아웃이 발생합니다

**원인:** 광고/분석 요청이 계속 발생하여 `networkidle` 조건에 도달하지 못함  
**해결:** `navigateTo()`는 `load` 이벤트를 primary gate로 사용하고, `networkidle`은 8초 best-effort로 처리합니다. 이미 수정되어 있으니 서버를 재시작하세요.

### Q: `data/page-graph.json`을 초기화하고 싶습니다

```bash
rm data/page-graph.json
# 다음 실행 시 빈 그래프로 시작
```

### Q: `.env` 파일이 적용되지 않습니다

`npm run dev` 명령은 `node --env-file=.env src/server.js`를 실행합니다.  
`.env` 파일이 프로젝트 루트에 있는지 확인하세요. `.env.example`을 복사해서 시작하세요:

```bash
cp .env.example .env
```

### Q: 트리거 후보가 0개입니다

앵커 인터랙티비티 필터가 모든 앵커를 제거하고 버튼/aria-expanded 요소도 없는 경우입니다.  
`DEBUG_NODES=true`로 실행하면 `filtered-node-debug.json`에서 노드 품질 정보를 확인할 수 있습니다.  
`trigger-candidates.json`은 필터링 후 목록을 담으므로, 필터링 전 raw 후보를 보려면 `triggerDiscovery.js`에서 `rawCandidates`를 별도로 저장하도록 수정하세요.

---

*이 문서는 코드 변경 시 함께 업데이트되어야 합니다.*
