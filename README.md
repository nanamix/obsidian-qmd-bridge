# QMD Bridge for Obsidian

[qmd](https://github.com/qmd-lab/qmd) CLI 검색 도구를 Obsidian 내에서 직접 사용할 수 있게 해주는 플러그인입니다.
터미널 없이 Obsidian 사이드바와 명령 팔레트만으로 모든 qmd 기능을 활용하세요.

## 기능

- **사이드바 검색 패널** — BM25 / Vector / Deep 검색 방식 선택, 컬렉션 필터, 결과 클릭 시 해당 노트 바로 열기
- **인덱스 업데이트** (`qmd update`) — 실시간 진행 로그 표시
- **임베딩 생성** (`qmd embed`) — 실시간 진행 로그 표시
- **상태 확인** (`qmd status`)
- **컬렉션 목록** (`qmd collection list`)

## 요구 사항

- [qmd](https://github.com/qmd-lab/qmd) v1.0.7 이상 설치
- Obsidian 1.4.0 이상
- 데스크탑 전용 (`isDesktopOnly: true`)

## 설치

### 수동 설치

1. 릴리즈 페이지에서 `main.js`, `manifest.json`, `styles.css` 다운로드
2. 볼트의 `.obsidian/plugins/qmd-bridge/` 폴더에 복사
3. Obsidian 재시작 후 **Settings > Community Plugins > QMD Bridge** 활성화

### 소스에서 빌드

```bash
git clone https://github.com/your-username/obsidian-qmd-bridge
cd obsidian-qmd-bridge
npm install
npm run build
```

## 설정

**Settings > QMD Bridge** 에서:

1. **qmd 실행 파일 경로** 확인 (기본값: `~/.asdf/shims/qmd`)
   → "테스트" 버튼으로 연결 확인
2. **"config에서 로드"** 버튼 클릭
   → `~/.config/qmd/index.yml`에서 컬렉션 경로 자동 로드

## 사용법

### 검색 패널

리본 아이콘(🔍) 클릭 또는 명령 팔레트 → `QMD Bridge: 검색 패널 열기`

| 검색 타입 | qmd 명령 | 설명 |
|-----------|----------|------|
| BM25 | `qmd search` | 키워드 정확 매칭, 빠름 |
| Vector | `qmd vsearch` | 의미 기반 유사도 검색 |
| Deep | `qmd query` | 쿼리 확장 + 리랭킹, 권장 |

### 액션 버튼

검색 패널 상단의 버튼으로 바로 실행:

| 버튼 | 기능 |
|------|------|
| ↻ Update | 인덱스 재구축 |
| ⚡ Embed | 벡터 임베딩 생성 |
| ℹ Status | 인덱스 상태 확인 |
| ≡ Collections | 컬렉션 목록 |

### 명령 팔레트 (`Cmd+P`)

- `QMD Bridge: 검색 패널 열기`
- `QMD Bridge: 인덱스 업데이트`
- `QMD Bridge: 임베딩 생성`
- `QMD Bridge: QMD 상태 보기`
- `QMD Bridge: 컬렉션 목록 보기`

## 개발

```bash
npm run dev      # 파일 변경 감지 + 자동 빌드
npm run build    # 프로덕션 빌드
npm run deploy   # 빌드 + 볼트에 자동 배포
```

`deploy` 스크립트의 볼트 경로는 `package.json`에서 수정하세요.

## 라이선스

MIT
