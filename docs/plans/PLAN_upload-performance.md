# Implementation Plan: 업로드 성능/안정성 개선

**Status**: 🔄 In Progress
**Started**: 2026-02-21
**Last Updated**: 2026-02-21

---

**CRITICAL INSTRUCTIONS**: After completing each phase:
1. Check off completed task checkboxes
2. Run all quality gate validation commands
3. Verify ALL quality gate items pass
4. Update "Last Updated" date above
5. Document learnings in Notes section
6. Only then proceed to next phase

**DO NOT skip quality gates or proceed with failing checks**

---

## Context

현재 notion-uploader의 업로드 파이프라인에는 안정성과 성능에 심각한 문제가 있다:

1. **메모리 폭발**: `complete/route.ts`에서 `Buffer.concat()`으로 전체 파일을 메모리에 로드 → 5GB 파일 시 OOM (Vercel 함수 최대 3GB)
2. **재시도 없음**: 클라이언트/서버 모두 retry 로직 없음. 일시적 네트워크 오류에도 전체 업로드 실패
3. **순차 처리**: 청크를 하나씩 순차 전송해 대역폭 낭비
4. **진행률 정체**: 서버 측 Notion 전송 중 진행률이 92%에서 멈춤

## Success Criteria

- [ ] 100MB+ 파일 업로드 시 메모리 사용량 O(10MB) 이하
- [ ] 일시적 네트워크 오류 시 자동 재시도로 업로드 성공
- [ ] Notion API 429 응답 시 Retry-After 존중하며 재시도
- [ ] 청크 병렬 업로드로 전송 시간 2~3배 단축
- [ ] 서버 측 Notion 전송 중 실시간 진행률 표시

---

## Architecture Decisions

| Decision | Rationale | Trade-offs |
|----------|-----------|------------|
| 서버/클라이언트 retry 분리 (`lib/retry.ts`, `lib/client-retry.ts`) | Node.js와 브라우저 환경 차이 (AbortController 등) | 로직 중복이 있지만 환경별 최적화 가능 |
| 스트리밍 재청킹 (4MB→10MB 버퍼링) | 메모리를 O(FILE_SIZE)→O(10MB)로 감소 | 구현 복잡도 증가 |
| complete 엔드포인트 SSE 변환 | 서버 측 진행률을 실시간 전달 | 기존 JSON 응답 패턴 변경 |

---

## Dependencies

### External Dependencies (new)
- `vitest` ^3.x: 테스트 러너
- `happy-dom`: 브라우저 환경 모킹

---

## Critical Files

| File | 변경 Phase | 역할 |
|------|-----------|------|
| `lib/notion.ts` | 1 | 4개 fetch 호출에 retry 적용 |
| `components/FileDropzone.tsx` | 1, 3, 4 | retry, 병렬 청크, SSE 진행률 |
| `app/api/upload/complete/route.ts` | 2, 4 | 스트리밍 재청킹, SSE 응답 |
| `lib/retry.ts` (new) | 1 | 서버 측 fetch retry + 429 처리 |
| `lib/client-retry.ts` (new) | 1 | 클라이언트 측 fetch retry |
| `lib/stream-rechunker.ts` (new) | 2 | 4MB→10MB 스트리밍 변환 |
| `lib/upload-pool.ts` (new) | 3 | 병렬 청크 업로드 풀 |

---

## Implementation Phases

### Phase 0: 테스트 인프라 구축
**Goal**: vitest 설치 및 기존 코드 베이스라인 테스트 작성
**Estimated Time**: 1시간

#### Tasks

- [ ] **0.1**: vitest, happy-dom 설치 및 `vitest.config.ts` 생성
  - `package.json`에 `"test": "vitest run"`, `"test:watch": "vitest"` 추가
  - path alias `@/*` 설정
- [ ] **0.2**: `__tests__/lib/notion.test.ts` 작성
  - `fetch` 모킹하여 `createFileUpload`, `sendFileData`, `completeMultiPartUpload`, `attachFileToPage` 기본 동작 검증
- [ ] **0.3**: `npm run test` 통과 확인

#### Quality Gate
- [ ] `npm run test` 전체 통과
- [ ] `npm run build` 성공

---

### Phase 1: Retry 로직 + 429 처리
**Goal**: 모든 네트워크 호출에 exponential backoff 재시도 및 Notion API rate limit 처리
**Estimated Time**: 3시간

#### Tasks

**RED: 테스트 먼저**
- [ ] **1.1**: `__tests__/lib/retry.test.ts` 작성
  - exponential backoff 타이밍 검증
  - 429 + `Retry-After` 헤더 파싱 (초 단위, HTTP date 형식)
  - max retries 초과 시 throw
  - 400/401/403/404는 즉시 throw (재시도 안함)
  - 네트워크 에러(TypeError) 재시도
- [ ] **1.2**: `__tests__/lib/client-retry.test.ts` 작성 (동일 시나리오, 브라우저 환경)

**GREEN: 구현**
- [ ] **1.3**: `lib/retry.ts` 구현
  ```typescript
  interface RetryOptions {
    maxRetries: number;          // default: 3
    baseDelayMs: number;         // default: 1000
    maxDelayMs: number;          // default: 30000
    retryableStatuses: number[]; // default: [429, 500, 502, 503, 504]
  }
  export async function fetchWithRetry(url, init, options?): Promise<Response>
  ```
  - jitter 포함 exponential backoff: `min(base * 2^attempt + random, maxDelay)`
  - 429: `Retry-After` 헤더를 delay 하한값으로 사용
- [ ] **1.4**: `lib/client-retry.ts` 구현 (브라우저 호환, AbortController 지원)
- [ ] **1.5**: `lib/notion.ts` 수정 — 4개 `fetch` 호출을 `fetchWithRetry`로 교체
  - `sendFileData`: `maxRetries: 5` (대용량 데이터 전송이므로)
  - 나머지: `maxRetries: 3`
- [ ] **1.6**: `components/FileDropzone.tsx` 수정 — 4개 `fetch` 호출을 `clientFetchWithRetry`로 교체
  - init, chunk, complete, cleanup 호출

**REFACTOR**
- [ ] **1.7**: 서버/클라이언트 retry 공통 옵션 타입을 `lib/retry-types.ts`로 추출 (중복 최소화)

#### Quality Gate
- [ ] 모든 retry 테스트 통과
- [ ] `npm run build` 성공
- [ ] 수동 테스트: 소규모 파일 업로드 정상 동작 확인

---

### Phase 2: 스트리밍 재청킹 (메모리 최적화)
**Goal**: complete 단계에서 Buffer.concat() 제거, 메모리 O(10MB)로 제한
**Estimated Time**: 3시간

#### Tasks

**RED: 테스트 먼저**
- [ ] **2.1**: `__tests__/lib/stream-rechunker.test.ts` 작성
  - 20MB 이하 파일 (single-part): Blob 청크 → 단일 전송
  - 30MB 파일 (3 x 4MB Blob → 3 x 10MB Notion parts 재정렬)
  - 100MB 파일 (25 x 4MB Blob → 10 x 10MB Notion parts)
  - 스트림 중간 에러 시 처리
  - 진행률 콜백 호출 검증

**GREEN: 구현**
- [ ] **2.2**: `lib/stream-rechunker.ts` 구현
  ```typescript
  export async function streamToNotion(
    uploadId: string,
    sortedBlobs: { url: string; pathname: string }[],
    contentType: string,
    useMultiPart: boolean,
    onPartSent?: (partNumber: number, totalParts: number) => void
  ): Promise<void>
  ```
  알고리즘:
  1. 10MB 버퍼 유지
  2. Blob에서 4MB 청크를 하나씩 fetch → 버퍼에 추가
  3. 버퍼 ≥ 10MB 시 → `sendFileData()`로 Notion에 전송, 버퍼 비움
  4. 마지막 잔여 데이터 flush
  5. multi-part인 경우 `completeMultiPartUpload()` 호출
- [ ] **2.3**: `app/api/upload/complete/route.ts` 리팩터링
  - 기존 lines 64-121 (Buffer.concat + 재분할) → `streamToNotion()` 호출로 교체
  - `attachFileToPage()` 호출 유지
  - 정리 로직 유지

**REFACTOR**
- [ ] **2.4**: 에러 시 정리 로직 정비 (streamToNotion 내부 에러도 cleanup 보장)

#### Quality Gate
- [ ] 모든 테스트 통과
- [ ] `npm run build` 성공
- [ ] 수동 테스트: 20MB+ 파일 업로드 성공 (Vercel 배포 후)

---

### Phase 3: 병렬 청크 업로드
**Goal**: 클라이언트에서 3개 청크 동시 전송으로 업로드 속도 향상
**Estimated Time**: 2시간

#### Tasks

**RED: 테스트 먼저**
- [ ] **3.1**: `__tests__/lib/upload-pool.test.ts` 작성
  - 동시성 제한 준수 (최대 N개만 동시 실행)
  - 모든 청크 완료 확인
  - 1개 실패 시 나머지 중단 + 에러 전파
  - 진행률 콜백 정확성

**GREEN: 구현**
- [ ] **3.2**: `lib/upload-pool.ts` 구현
  ```typescript
  export async function uploadChunksParallel(
    chunks: { blob: Blob; partNumber: number }[],
    uploadFn: (blob: Blob, partNumber: number) => Promise<void>,
    options: { concurrency: number; onProgress?: (completed: number, total: number) => void }
  ): Promise<void>
  ```
- [ ] **3.3**: `components/FileDropzone.tsx` 수정
  - 기존 순차 `for` 루프 (lines 87-115) → `uploadChunksParallel()` 호출
  - concurrency: 3
  - 진행률 계산: `5 + (completed / total) * 85`

#### Quality Gate
- [ ] 모든 테스트 통과
- [ ] `npm run build` 성공
- [ ] 수동 테스트: 대용량 파일 업로드 시 체감 속도 향상 확인

---

### Phase 4: 서버 진행률 SSE
**Goal**: complete 처리 중 Notion 전송 진행률을 실시간으로 클라이언트에 전달
**Estimated Time**: 2시간

#### Tasks

**RED: 테스트 먼저**
- [ ] **4.1**: `__tests__/lib/sse-parser.test.ts` 작성
  - SSE 이벤트 파싱 정확성
  - 진행률 계산 매핑 (phase별 퍼센트)

**GREEN: 구현**
- [ ] **4.2**: `app/api/upload/complete/route.ts` 수정 — SSE 응답으로 변환
  - 기존 `app/api/upload/route.ts`의 SSE 패턴 참조 (lines 49-66)
  - `streamToNotion()`의 `onPartSent` 콜백에서 SSE 이벤트 발행
  - 이벤트 단계: `reading` → `sending` (partNumber/totalParts) → `completing` → `attaching` → `done`
- [ ] **4.3**: `components/FileDropzone.tsx` 수정 — complete 응답을 SSE로 소비
  - `response.body.getReader()` + `TextDecoder`로 스트림 읽기
  - SSE 이벤트 파싱 → 진행률 업데이트
  - 진행률 매핑: sending → 92~97%, completing → 97%, attaching → 98%, done → 100%
- [ ] **4.4**: complete 호출은 retry 대상에서 제외 (SSE 스트림이므로, 내부 Notion API 호출만 서버 측 retry)

#### Quality Gate
- [ ] 모든 테스트 통과
- [ ] `npm run build` 성공
- [ ] 수동 테스트: 대용량 파일 업로드 시 92%에서 멈추지 않고 부드럽게 진행

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| 스트리밍 재청킹 시 Blob fetch 순서 오류 | Low | High | sortedBlobs 정렬 검증 테스트 + 파트 번호 명시적 추적 |
| Notion API 429 빈도 증가 (병렬 전송 시) | Medium | Medium | 서버 측 retry가 429 처리. 필요 시 concurrency 낮춤 |
| SSE 스트림이 Vercel에서 조기 종료 | Low | Medium | maxDuration=800 유지, SSE 에러 이벤트로 클라이언트에 알림 |
| 병렬 청크 업로드 시 순서 보장 | Low | High | Blob 저장 시 partNumber 기반 파일명, complete에서 정렬 (기존 로직) |

---

## Rollback Strategy

| Phase | Rollback 방법 |
|-------|--------------|
| Phase 0 | vitest 관련 파일/설정 삭제, package.json devDependencies 제거 |
| Phase 1 | `lib/notion.ts`, `FileDropzone.tsx`의 fetch 호출을 bare fetch로 원복. retry 파일 삭제 |
| Phase 2 | `complete/route.ts`를 Buffer.concat 방식으로 원복. stream-rechunker 삭제 |
| Phase 3 | `FileDropzone.tsx` 청크 루프를 순차 for로 원복. upload-pool 삭제 |
| Phase 4 | `complete/route.ts`를 JSON 응답으로 원복. FileDropzone SSE 소비 코드 제거 |

---

## Verification

각 Phase 완료 후:
```bash
npm run test          # 전체 테스트 통과
npm run build         # 빌드 성공
npm run dev           # 로컬 개발 서버 + 소규모 파일 업로드 테스트
vercel --prod         # Vercel 배포 후 대용량 파일 테스트
```

최종 검증:
1. 5MB 파일 업로드 → 정상 완료 (single-part)
2. 50MB 파일 업로드 → multi-part 스트리밍 + 진행률 실시간 표시
3. 업로드 중 네트워크 끊김 시뮬레이션 → 자동 재시도 후 성공
4. 진행률 바가 92%에서 멈추지 않고 부드럽게 100%까지 진행

---

## Progress Tracking

- **Phase 0**: 0%
- **Phase 1**: 0%
- **Phase 2**: 0%
- **Phase 3**: 0%
- **Phase 4**: 0%

**Overall Progress**: 0%

---

## Notes & Learnings

_구현 중 기록 예정_
