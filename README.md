# muvel-mcp

[![CI](https://github.com/Irongolem24/muvel-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Irongolem24/muvel-mcp/actions/workflows/ci.yml)

[Muvel(뮤블)](https://muvel.app) 클라우드 소설을 Claude Code, Codex 같은 AI 에이전트가 읽고 쓸 수 있게 해 주는 **비공식** MCP 서버입니다.

*An unofficial [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI coding agents read and write your novels on Muvel, a Korean web-novel editor.*

> [!WARNING]
> KimuSoft(Muvel 개발사)와 관계없는 개인 프로젝트입니다. muvel.app 웹 앱이 내부적으로 쓰는 API를 호출하므로 Muvel이 업데이트되면 동작이 깨질 수 있습니다. 본인 계정의 본인 작품에만 사용하세요. (확인 기준: Muvel 2.11.5)

## 무엇을 할 수 있나

에이전트에게 소설 전체(회차, 위키, 메모, 복선, 등장 관계)를 보여주고 다음 같은 일을 시킬 수 있습니다.

- 다음 회차 초안 작성, 퇴고
- 회차 평가와 피드백. 피드백은 회차 코멘트로 남김
- 위키와 본문을 대조한 설정 충돌 검사, 개연성·흐름 검사
- 복선 등록, 설치·회수 위치 연결, 아직 회수하지 않은 복선 찾기
- 본문을 바탕으로 인물·장소 위키 문서 작성

## 요구 사항

- Node.js 22 이상
- [Muvel 데스크톱 앱](https://github.com/KimuSoft/muvel-public/releases)에 로그인한 상태. 데스크톱 앱이 없으면 [`MUVEL_REFRESH_TOKEN`](#환경변수)을 직접 지정해야 합니다.

## 설치

```bash
git clone https://github.com/Irongolem24/muvel-mcp.git
cd muvel-mcp
npm install        # 설치하면서 빌드(dist/)까지 자동으로 됩니다
```

### Claude Code
```bash
claude mcp add muvel-mcp -s user -- node /절대/경로/muvel-mcp/dist/index.js
```

### Codex
```bash
codex mcp add muvel-mcp -- node /절대/경로/muvel-mcp/dist/index.js
```

등록한 뒤 새 세션에서 이렇게 요청해 보세요: *"뮤블에서 내 소설 목록 보여줘"*, *"○○ 소설 1~10화 읽고 설정 충돌 찾아줘"*.

## 앱 화면 실시간 반영 (선택)

Muvel 앱에는 서버 변경을 받아오는 기능이 없습니다. 그래서 AI가 수정해도 열려 있는 편집기에는 회차를 나갔다 들어와야 보입니다. 아래 스크립트로 Muvel을 실행하면, MCP가 수정한 직후 그 문서가 화면에 열려 있을 때 편집기를 자동으로 다시 불러옵니다(약 0.3초).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\launch-muvel-debug.ps1
```

- **입력 중 보호**: 사용자가 입력 중이면 입력이 2.5초 멈출 때까지 기다립니다. 앱이 사용자의 입력을 먼저 저장하도록 하기 위해서입니다.
- **저장 안 된 입력**: 앱에 아직 저장되지 않은 입력이 있으면 새로고침을 건너뜁니다.
- **동작 원리와 보안**: Muvel의 WebView2 원격 디버깅 포트(127.0.0.1:9333)를 사용합니다. 이렇게 실행하는 동안에는 **이 PC의 다른 프로그램도 Muvel을 조작할 수 있으니**, 필요할 때만 이 방식으로 실행하세요.
- **일반 실행 시**: Muvel을 평소처럼 실행하면 이 기능만 조용히 꺼지고, 나머지는 그대로 동작합니다.

## 동작 방식

### 인증
Muvel 데스크톱 앱이 OS 키링(Windows 자격 증명 관리자, macOS 키체인 등)에 저장한 refresh token을 **읽기만** 해서 access token을 발급받습니다. Muvel은 refresh token을 갱신 때마다 새로 바꾸지 않기 때문에, 이 서버가 토큰을 갱신해도 데스크톱 앱의 로그인 상태에는 영향이 없습니다.

### 본문 형식
본문은 **한 줄 = 한 블록(문단)** 형식의 텍스트로 주고받습니다.

| 표기 | 회차 | 위키 |
|---|---|---|
| 일반 텍스트 | 지문·대사 | 문단 |
| `> ` | 인용 블록 | 인용 |
| `// ` | 코멘트 블록 | |
| `---` | 구분선 | |
| `#` ~ `######` | | 제목 |
| `[이미지:abcd1234]`, `[표:…]`, `[목록:…]` | 수정할 수 없는 블록. 그대로 두거나, 줄을 빼서 삭제만 가능 | |
| `<br>` | 블록 안 줄바꿈 | 블록 안 줄바꿈 |

일반 문단인데 위 표기처럼 보이는 줄은 맨 앞에 `\`를 붙여 구분합니다(예: `\---`).

### 원고를 지키는 장치
- **수정 전 자동 스냅샷**: 본문을 고치기 전 상태가 저장되므로 앱의 버전 기록에서 복원할 수 있습니다.
- **블록 ID 유지**: 바뀐 문단만 서버에 반영하고, 바뀌지 않은 문단은 블록 ID를 유지합니다. 문단에 걸어둔 복선과 코멘트가 끊기지 않습니다.
- **동시 수정 보호**: Muvel 서버는 오래된 버전의 쓰기도 받아들입니다. 그래서 저장 직전에 버전을 다시 확인하고, 그 사이 앱에서 수정되었으면 저장하지 않습니다. 전체 교체(`muvel_write_episode`)에는 `expectedVersion`이 필수입니다.
- **제외한 기능**: 삭제 도구와 권한·공유 관련 도구는 없습니다.

## 도구

| 분류 | 도구 |
|---|---|
| 조회 | `muvel_list_novels`, `muvel_get_novel`, `muvel_search` |
| 회차 | `muvel_read_episode`, `muvel_read_episodes`, `muvel_create_episode`, `muvel_update_episode_info`, `muvel_write_episode`, `muvel_edit_episode` |
| 위키 | `muvel_read_wiki_page`, `muvel_read_wiki`, `muvel_create_wiki_page`, `muvel_update_wiki_page`, `muvel_edit_wiki_page` |
| 메모 | `muvel_list_memos`, `muvel_create_memo`, `muvel_update_memo` |
| 복선 | `muvel_list_clues`, `muvel_create_clue`, `muvel_update_clue`, `muvel_link_clue` |
| 등장 관계 | `muvel_list_relations`, `muvel_set_relations` |
| 코멘트 | `muvel_list_comments`, `muvel_add_comment` |
| 스냅샷 | `muvel_list_snapshots`, `muvel_read_snapshot`, `muvel_create_snapshot`, `muvel_restore_snapshot` |

## 환경변수

| 변수 | 설명 |
|---|---|
| `MUVEL_READ_ONLY=1` | 쓰기 도구를 등록하지 않음 |
| `MUVEL_AUTO_SNAPSHOT=0` | 수정 전 자동 스냅샷을 끔 |
| `MUVEL_REFRESH_TOKEN` | 키링 대신 사용할 refresh token |
| `MUVEL_API_BASE` | API 주소 (기본값 `https://muvel.app/api`) |
| `MUVEL_LIVE_REFRESH=0` | 앱 화면 실시간 반영을 끔 |
| `MUVEL_CDP_PORT` | 실시간 반영에 쓸 디버깅 포트 (기본값 `9333`) |

예: 읽기 전용으로 등록
```bash
claude mcp add muvel-mcp -s user -e MUVEL_READ_ONLY=1 -- node /절대/경로/muvel-mcp/dist/index.js
```

## 개발

```bash
npm run dev                                   # tsx로 바로 실행
npm test                                      # 단위 테스트 (네트워크 사용 안 함)
npm run roundtrip-check                       # 읽기 전용: 내 모든 문서가 형식 변환 후 그대로 복원되는지 확인
MUVEL_E2E_NOVEL=<테스트용 novelId> npm run e2e  # 실제 API로 모든 도구 실행. 만든 데이터는 끝난 뒤 영구 삭제
```

`e2e`는 실제 계정에 데이터를 만들었다가 지웁니다. 반드시 테스트용 소설 ID로만 실행하세요.

`docs/api-surface.txt`에는 웹 번들에서 추출한 Muvel API 목록이 있습니다.

## 라이선스

[MIT](LICENSE)
