# LLMNav

[English README](README.md)

LLMNav는 코딩 에이전트가 저장소 전체를 무작정 훑지 않고, 작업 설명에서 관련 코드로 곧바로 이동하도록 만드는 결정적 시맨틱 내비게이션 계층이다.

소수의 중요 경계에 `llmnav/1` 카드를 붙이면 CLI가 현재 경로·선언·시그니처와 결합해 검색 인덱스와 캐시 친화적 카탈로그를 생성한다. 경로, 줄 번호, 호출 관계처럼 쉽게 낡는 정보는 사람이 주석에 적지 않는다.

## 설치

```sh
npm install --save-dev llmnav
npx llmnav init --agents all --package-scripts
```

`init`은 명시적으로 실행할 때만 저장소를 수정한다. npm 설치 과정에서는 `postinstall`을 실행하지 않는다. 에이전트 지침 파일을 만들지 않으려면 `--agents none`을 쓴다.

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

## 기본 흐름

```sh
npx llmnav format
npx llmnav check
npx llmnav generate
npx llmnav query "재사용된 리프레시 토큰이면 같은 세션 전체를 폐기" --top 5
npx llmnav show auth.session.rotate
npx llmnav context auth.session.rotate --depth 1 --budget 2500
```

설치 시 생성되는 에이전트 지침은 광역 grep이나 디렉터리 순회보다 `query → show → context`를 먼저 사용하도록 안내한다. `--agents all`은 AGENTS.md, CLAUDE.md, GitHub Copilot 지침, Cursor 규칙을 함께 만든다.

## 어디에 적용하는가

도메인 모듈, 공개 API 진입점, 인증·결제·개인정보 경계, 마이그레이션, 여러 외부 부작용을 조정하는 함수, 중요한 불변조건에만 붙인다. 단순 getter, 생성 코드, 자명한 wrapper, 모든 private helper에는 붙이지 않는다.

## 주요 문서

규격은 [docs/spec.md](docs/spec.md), 빠른 도입은 [docs/quickstart.md](docs/quickstart.md), 에이전트 연동은 [docs/agent-integration.md](docs/agent-integration.md), CI 강제는 [docs/ci.md](docs/ci.md), 설정은 [docs/configuration.md](docs/configuration.md), 라이브러리 API는 [docs/api.md](docs/api.md), npm 배포는 [docs/publishing.md](docs/publishing.md)를 참고한다.

## 상태

0.1은 실제 사용할 수 있는 실험 버전이다. 시맨틱 카드, 린터, 결정적 인덱스, 다국어 별칭 검색, 검색 회귀 평가, 에이전트 지침 설치를 제공한다. SCIP와 완전한 호출 그래프는 이후 구조 enricher로 추가한다.

MIT License
