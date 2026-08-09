# LLMNav

[English README](README.md)

LLMNav는 코딩 에이전트가 저장소 전체를 무작정 훑지 않고, 작업 문장에서 관련 코드로 곧바로 이동하도록 만드는 결정적 시맨틱 내비게이션 계층이다.

소수의 중요 경계에 `llmnav/1` 카드를 붙이면 CLI가 현재 경로·선언·시그니처와 결합해 카탈로그, 호환 인덱스, 영속 역색인을 생성한다. 경로, 줄 번호, 호출 관계처럼 쉽게 낡는 정보는 소스 주석에 적지 않는다.

## v0.2의 핵심

| 기능 | 동작 |
| --- | --- |
| 결정적 역색인 | 토큰 사전과 압축 posting list를 `search-index.json`에 저장해 질의마다 전체 카드를 다시 토큰화하지 않는다 |
| 파일 단위 증분 처리 | 변경되지 않은 파일은 읽기와 파싱을 생략하고, 내용이 바뀐 파일만 다시 분석한다 |
| 카드 단위 증분 처리 | 검색 문서 해시가 바뀐 카드만 다시 토큰화하고 posting을 교체한다 |
| 트랜잭션 생성 | 새 캐시를 별도 디렉터리에서 완성·검증한 뒤 교체하며, 실패나 프로세스 중단 시 이전 캐시를 복구한다 |
| 변경 영향 출력 | `generate --json`이 변경 카드와 영향받은 저장소·모듈 카탈로그를 기계가 읽을 수 있는 형태로 반환한다 |
| v0.1 호환 | `llmnav/1` 문법과 `index.json` schemaVersion 1을 유지한다 |

Node.js 22 이상, ESM, 런타임 의존성 0개를 유지한다. 네트워크 요청, 설치 훅, 저장소 코드 실행은 없다.

## 설치

```sh
npm install --save-dev llmnav
npx llmnav init --agents all --package-scripts
```

`init`을 명시적으로 실행할 때만 저장소를 수정한다. npm 설치 과정에서는 `postinstall`을 실행하지 않는다. 에이전트 지침이 필요 없으면 `--agents none`을 쓴다.

## 카드 예시

```ts
/* llmnav/1 symbol
id=auth.session.rotate
role=Rotate one refresh-token family atomically and reject replayed tokens.
search=refresh token|token rotation|token family|replay detection
invariant=At most one live refresh token exists per family.
invariant=Replay revokes the entire token family.
effect=db.write(session_tokens)|event.emit(auth.session.revoked)
risk=auth|concurrency
rel=test>auth.session.rotate.contract
stability=contract
*/

export async function rotateSession(input: RotateSessionInput) {
  // implementation
}
```

ID는 파일 경로나 현재 함수명이 아니라 오래 유지할 기능의 정체성을 나타낸다. 파일 이동과 함수 이름 변경 뒤에도 그대로 둔다.

## 기본 흐름

```sh
npx llmnav format
npx llmnav check
npx llmnav generate
npx llmnav query "재사용된 리프레시 토큰이면 같은 세션 전체를 폐기" --top 5
npx llmnav show auth.session.rotate
npx llmnav context auth.session.rotate --depth 1 --budget 2500
```

설치된 에이전트 지침은 광역 grep과 디렉터리 순회 전에 `query → show → context`를 사용하도록 안내한다. `--agents all`은 AGENTS.md, CLAUDE.md, GitHub Copilot 지침, Cursor 규칙을 함께 관리한다.

## 증분 생성 방식

```text
stat fingerprint 동일   → 파일을 읽지 않고 기존 파싱 결과 재사용
stat 변경, SHA-256 동일 → 파일은 한 번 읽되 기존 파싱 결과 재사용
내용 변경               → 해당 파일만 파싱하고 변경 카드만 재토큰화
파일 삭제               → 해당 카드와 posting 제거
```

결정적 결과는 `.llmnav/cache`에 들어가며 커밋 대상이다. 빠른 변경 감지에 쓰는 `.llmnav/state/stat-hints.json`은 실행 환경에 따라 달라질 수 있으므로 커밋하지 않는다.

## 실패와 중단 복구

캐시 생성은 staging 디렉터리에서 모든 파일을 완성하고 manifest를 검증한 뒤 디렉터리를 교체한다. 쓰기 실패, 검증 실패, rename 실패, 프로세스 강제 종료가 발생해도 이전 캐시를 보존한다. 다음 `query`, `generate`, `doctor`가 남은 transaction journal을 읽고 이전 캐시를 복구한다.

Windows에서 자주 발생하는 `EPERM`, `EBUSY`, `EACCES`, `EEXIST`, `ENOTEMPTY` rename 오류는 제한적으로 재시도한다. 저장소 CI는 Linux와 `windows-latest`, Node.js 22와 24 조합에서 같은 테스트를 실행한다.

## 변경 정보 JSON

```sh
npx llmnav generate --json
```

출력에는 기존 필드와 함께 다음 정보가 들어간다.

```json
{
  "changedCards": [
    {
      "id": "billing.credit.reserve",
      "change": "modified",
      "dimensions": ["semantic"]
    }
  ],
  "affectedCatalogs": [
    {
      "file": ".llmnav/cache/modules/billing.credit.txt",
      "kind": "module",
      "id": "billing.credit"
    }
  ]
}
```

`incremental.files`에는 파싱·재사용 파일 수가, `incremental.cards`에는 재토큰화·재사용 카드 수가, `transaction`에는 커밋·복구 상태가 기록된다.

## 생성 파일

```text
.llmnav/
  config.json
  ids.jsonl
  lexicon.json
  order.lock
  state/                    # 커밋하지 않음
    stat-hints.json
  cache/                    # 결정적 결과, 커밋 권장
    index.json              # v0.1 호환 schemaVersion 1
    cards.jsonl
    search-index.json       # 압축 토큰 사전, 구문 문서, posting list
    file-state.json         # 파일별 파싱 상태
    repo-core.txt
    agent-context.md
    manifest.json
    modules/
```

생성된 경로·선언·시그니처·해시는 캐시에만 들어간다. 소스 주석에는 절대 기록하지 않는다.

## 적용 범위

도메인 모듈, 공개 API 진입점, 인증·결제·개인정보 경계, 마이그레이션, 여러 외부 부작용을 조정하는 함수, 중요한 불변조건에만 붙인다. 단순 getter, 생성 코드, 자명한 wrapper, 모든 private helper에는 붙이지 않는다.

## 측정

대형 synthetic fixture를 이용한 검색 정확도·속도·메모리 회귀 테스트가 기본 테스트에 포함돼 있다. 실제 fresh-process 질의와 한 파일 증분 재생성, 강제 전체 재생성 결과는 [docs/performance-v0.2.md](docs/performance-v0.2.md)에 기록한다. 이 문서는 `npm run benchmark:v0.2`가 만든 실제 측정값만 싣고 추정치는 넣지 않는다.

## 범위 밖

v0.2에는 MCP, embeddings, SCIP, hosted service, 완전한 호출 그래프가 없다. 이후 생성 구조 확장 기능으로 다루되, 파생된 호출·참조 관계를 소스 주석에 되쓰는 설계는 채택하지 않는다.

## 주요 문서

[규격](docs/spec.md), [빠른 도입](docs/quickstart.md), [CLI](docs/cli.md), [아키텍처](docs/architecture.md), [API](docs/api.md), [에이전트 연동](docs/agent-integration.md), [CI](docs/ci.md), [벤치마크 방법](docs/benchmarking.md), [v0.2 측정 결과](docs/performance-v0.2.md), [npm 배포](docs/publishing.md)를 참고한다.

## 개발 검증

```sh
npm ci
npm test
npm run test:coverage
npm run lint
npm run check
npm run smoke:pack
npm run benchmark:v0.2
```

LLMNav v0.2는 실험적이지만 실제 설치해 사용할 수 있는 CLI다. 소스 문법은 계속 `llmnav/1`이며 npm 패키지 버전과 독립적으로 관리한다.

MIT License
