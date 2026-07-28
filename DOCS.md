# 문서 인덱스

> **이 파일부터 읽는다.** 어떤 작업을 하려는지에 따라 어느 문서를 열지가 정해진다.
> 문서는 **정적(변하지 않음)** 과 **동적(계속 바뀜)** 으로 갈린다. 이 구분이 핵심이다 —
> 정적 문서는 참조만 하고 고치지 않으며, 동적 문서는 작업할 때마다 갱신한다.

## 작업별 진입점

| 하려는 것 | 읽을 문서 | 성격 |
|---|---|---|
| **작업 재개 · 지금 상태 파악** | [`docs/STATUS.md`](./docs/STATUS.md) | 동적 |
| **다음에 뭘 할지 고르기** | [`TODO.md`](./TODO.md) | 동적 |
| 코드 구조 · 데이터 계약 파악 | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 정적 |
| "왜 이렇게 만들었나" 확인 | [`docs/DECISIONS.md`](./docs/DECISIONS.md) | 정적 |
| 이미 고친 버그인지 확인 | [`docs/RESOLVED.md`](./docs/RESOLVED.md) | 정적 |
| UXP·Photoshop API 함정 | [`docs/UXP-NOTES.md`](./docs/UXP-NOTES.md) | 정적 |
| 필름 데이터 추가 | [`tools/README.md`](./tools/README.md) + [`tools/tds-catalog.md`](./tools/tds-catalog.md) | 정적 |
| 사용자용 설명 | [`README.md`](./README.md) | 동적 |

## 전체 목록

### 동적 — 현재와 앞으로

작업하면서 **반드시 갱신**한다. 여기 적힌 것이 낡으면 판단이 틀어진다.

| 파일 | 내용 | 갱신 시점 |
|---|---|---|
| [`docs/STATUS.md`](./docs/STATUS.md) | 현재 버전 · 동작하는 것 · **알려진 한계** · 미검증 항목 | 기능 추가/한계 발견 시 |
| [`TODO.md`](./TODO.md) | **미해결 작업만.** 우선순위 · 착수법 · 완료 기준 | 항목 해결/추가 시 |
| [`README.md`](./README.md) | 사용자 대면 — 설치 · 사용법 · 라이선스 | 릴리스 시 |

### 정적 — 결정과 지식

**이미 확정됐거나 변하지 않는 것.** 새 결정을 내렸을 때만 추가하고, 기존 항목은
뒤집힐 때만 고친다(뒤집으면 이유를 함께 적는다).

| 파일 | 내용 | 성격 |
|---|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 층 구조 · 파이프라인 순서 · 데이터 계약 · **깨면 안 되는 불변식** | 구조 |
| [`docs/DECISIONS.md`](./docs/DECISIONS.md) | 확정된 설계 결정과 **그 근거** · 실측으로 확정된 제약 | 근거 |
| [`docs/RESOLVED.md`](./docs/RESOLVED.md) | 해결된 이슈 아카이브 — 증상 → 원인 → 교훈 | 이력 |
| [`docs/UXP-NOTES.md`](./docs/UXP-NOTES.md) | Photoshop UXP 실측 지식 · 함정 · 검증 방법론 | 플랫폼 |
| [`docs/REVIEW-2026-07-28.md`](./docs/REVIEW-2026-07-28.md) | 전수 코드 검사 내역 — 남은 항목과 처리 결과 | 검사 |
| [`LICENSE.md`](./LICENSE.md) | PolyForm Noncommercial 1.0.0 | 법률 |
| [`tools/README.md`](./tools/README.md) | TDS 곡선 추출기 사용법과 함정 | 도구 |
| [`tools/tds-catalog.md`](./tools/tds-catalog.md) | 필름 TDS 문서 목록(등급별) | 데이터 |

### 아카이브 — 역사적 기록

**현행이 아니다.** 당시의 판단 과정과 실측 로그가 필요할 때만 연다. 여기 적힌
설계가 지금 코드와 다를 수 있으므로 **현행 판단의 근거로 쓰지 않는다.**

| 파일 | 무엇 | 왜 남겨두나 |
|---|---|---|
| [`docs/archive/v2plan.md`](./docs/archive/v2plan.md) | v2 설계 문서(1362줄) | 실측 로그·판단 착오 기록의 원본. 핵심은 DECISIONS로 옮김 |
| [`docs/archive/SPEC.md`](./docs/archive/SPEC.md) | v1 원본 기능 명세 | 프로젝트 출발점. **CMYK 그레이딩 등은 v2에서 폐기됨** |
| [`docs/archive/v2questions.md`](./docs/archive/v2questions.md) | v2 설계 질문지 + 답변 | 결정의 출처. 답변은 DECISIONS에 반영됨 |
| [`docs/archive/v1.3/`](./docs/archive/v1.3/) | v1.3 단일 플러그인 원본(2,686줄) | v2에서 엔진·마감으로 갈라지기 전의 마지막 형태. **고치지 말 것** — 현행 수정은 `apps/`에만 |

## 갱신 규칙

문서가 코드와 어긋나는 것이 가장 큰 위험이다. 다음을 지킨다.

1. **사실은 한 곳에만 적는다.** 같은 내용을 두 문서에 쓰지 말고 링크한다.
   (예: 그레인 물리는 ARCHITECTURE에만, 나머지는 참조)
2. **동적 문서에 완료된 것을 쌓지 않는다.** TODO에서 해결되면 RESOLVED로 옮기고
   TODO에서는 지운다. 취소선으로 남기지 않는다 — 미해결이 파묻힌다.
3. **정적 문서에 "지금 하는 중"을 쓰지 않는다.** 진행 중인 것은 TODO·STATUS에만.
4. **코드 위치는 경로로 적는다**(`core/optics/grainfield.js`). 실제로 존재하는지
   검증 가능해야 한다.
5. **추정과 실측을 구분한다.** 추정값에는 ⚠️ 와 근거를 함께 적는다.
