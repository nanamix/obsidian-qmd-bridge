import { FileSystemAdapter, ItemView, Notice, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import type QmdBridgePlugin from "./main";
import type { QmdResult } from "./qmd-executor";

export const SEARCH_VIEW_TYPE = "qmd-search-view";

/**
 * 검색 전용 사이드바 뷰.
 *
 * 흐름 개요:
 * onOpen
 *   -> 액션 버튼 / 검색 입력 / 옵션 / 결과 컨테이너 렌더링
 * doSearch
 *   -> qmd search/vsearch/query 실행
 *   -> showResults가 카드 단위로 점진 렌더링
 * 카드 클릭
 *   -> qmd URI를 볼트 상대 경로로 변환
 *   -> 정확 경로 또는 퍼지 경로로 TFile 탐색 후 열기
 *
 * 핵심 상태:
 * - fuzzyPathIndex: qmd의 경로 정규화와 실제 볼트 파일명을 연결하는 캐시
 * - renderGeneration: 늦게 끝난 비동기 렌더가 최신 결과를 덮어쓰지 않도록 막는 세대 번호
 */
export class QmdSearchView extends ItemView {
  plugin: QmdBridgePlugin;
  private searchInput: HTMLInputElement;
  private typeSelect: HTMLSelectElement;
  private collectionSelect: HTMLSelectElement;
  private limitInput: HTMLInputElement;
  private resultsContainer: HTMLElement;
  private fuzzyPathIndex: Map<string, TFile> | null = null;
  private renderGeneration = 0;

  constructor(leaf: WorkspaceLeaf, plugin: QmdBridgePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SEARCH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "QMD Search";
  }

  getIcon(): string {
    return "search";
  }

  /** 뷰를 처음 열 때 버튼/입력 UI를 조립하고 파일 시스템 변경 이벤트에 캐시 무효화를 연결한다. */
  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("qmd-search-container");

    // 액션 버튼 행 (Update / Embed / Status / Collections)
    const actions = container.createEl("div", { cls: "qmd-action-row" });

    const mkBtn = (label: string, icon: string, onClick: () => void) => {
      const btn = actions.createEl("button", { cls: "qmd-action-btn", title: label });
      btn.innerHTML = `<span class="qmd-action-icon">${icon}</span><span class="qmd-action-label">${label}</span>`;
      btn.addEventListener("click", onClick);
      return btn;
    };

    mkBtn("Update", "↻", () => this.plugin.runUpdate());
    mkBtn("Embed", "⚡", () => this.plugin.runEmbed());
    mkBtn("Status", "ℹ", () => this.plugin.showStatus());
    mkBtn("Collections", "≡", () => this.plugin.showCollections());

    // 컨트롤 영역
    const controls = container.createEl("div", { cls: "qmd-search-controls" });

    // 검색 입력창 + 버튼
    const searchRow = controls.createEl("div", { cls: "qmd-search-row" });
    const searchWrapper = searchRow.createEl("div", { cls: "qmd-search-input" });
    this.searchInput = searchWrapper.createEl("input", {
      type: "text",
      placeholder: "검색어 입력 후 Enter...",
    });
    this.searchInput.style.width = "100%";

    const searchBtn = searchRow.createEl("button", { text: "검색" });
    searchBtn.addEventListener("click", () => this.doSearch());
    this.searchInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") this.doSearch();
    });

    // 옵션 행
    const optRow = controls.createEl("div", { cls: "qmd-search-row" });

    // 검색 타입
    this.typeSelect = optRow.createEl("select", { cls: "qmd-select" });
    [
      { value: "bm25", label: "BM25" },
      { value: "vector", label: "Vector" },
      { value: "deep", label: "Deep" },
    ].forEach(({ value, label }) => {
      const opt = this.typeSelect.createEl("option", { text: label });
      opt.value = value;
    });
    this.typeSelect.value = this.plugin.settings.defaultSearchType;

    // 컬렉션 선택
    this.collectionSelect = optRow.createEl("select", { cls: "qmd-select" });
    this.updateCollectionOptions();

    // 결과 수
    this.limitInput = optRow.createEl("input", { type: "number" });
    this.limitInput.min = "1";
    this.limitInput.max = "50";
    this.limitInput.value = String(this.plugin.settings.defaultResultCount);
    this.limitInput.style.cssText = "width:50px; font-size:12px;";

    // 결과 영역
    this.resultsContainer = container.createEl("div", { cls: "qmd-results-container" });
    this.showEmpty("검색어를 입력하세요");

    this.registerEvent(this.app.vault.on("create", () => this.invalidateFuzzyPathIndex()));
    this.registerEvent(this.app.vault.on("delete", () => this.invalidateFuzzyPathIndex()));
    this.registerEvent(this.app.vault.on("rename", () => this.invalidateFuzzyPathIndex()));
  }

  /** 설정 변경 후에도 열린 뷰를 재사용하기 위해 컬렉션 드롭다운만 부분 갱신한다. */
  updateCollectionOptions() {
    if (!this.collectionSelect) return;
    this.collectionSelect.empty();

    const allOpt = this.collectionSelect.createEl("option", { text: "전체" });
    allOpt.value = "";

    const paths = this.plugin.settings.collectionPaths;
    for (const name of Object.keys(paths)) {
      const opt = this.collectionSelect.createEl("option", { text: name });
      opt.value = name;
    }

    const def = this.plugin.settings.defaultCollection;
    if (def && this.plugin.settings.collectionPaths[def]) {
      this.collectionSelect.value = def;
    }
  }

  /**
   * 현재 입력값을 읽어 검색 타입별 executor 메서드로 분기한다.
   * Deep 검색의 전체 컬렉션 실행은 자주 실패하는 편이라, 동작은 유지하되 사전 경고만 제공한다.
   */
  private async doSearch() {
    const query = this.searchInput.value.trim();
    if (!query) {
      new Notice("검색어를 입력하세요");
      return;
    }

    const type = this.typeSelect.value as "bm25" | "vector" | "deep";
    const collection = this.collectionSelect.value || undefined;
    const limit =
      parseInt(this.limitInput.value) || this.plugin.settings.defaultResultCount;

    // Deep 검색은 전체 컬렉션에서 실행 시 리랭킹 컨텍스트 크기 초과로 실패할 수 있음
    if (type === "deep" && !collection) {
      new Notice(
        "⚠️ Deep 검색은 특정 컬렉션을 선택하면 더 안정적으로 동작합니다.\n전체 컬렉션 검색을 계속 진행합니다...",
        5000
      );
    }

    this.showLoading();
    const renderId = ++this.renderGeneration;

    try {
      let results: QmdResult[];
      if (type === "bm25") {
        results = await this.plugin.executor.search(query, collection, limit);
      } else if (type === "vector") {
        results = await this.plugin.executor.vsearch(query, collection, limit);
      } else {
        results = await this.plugin.executor.deepQuery(query, collection, limit);
      }
      await this.showResults(results, renderId);
    } catch (e) {
      this.showError(e instanceof Error ? e.message : String(e));
    }
  }

  private showLoading() {
    this.resultsContainer.empty();
    this.resultsContainer.createEl("div", {
      cls: "qmd-loading",
      text: "검색 중...",
    });
  }

  private showEmpty(msg: string) {
    this.resultsContainer.empty();
    this.resultsContainer.createEl("div", { cls: "qmd-empty", text: msg });
  }

  private showError(msg: string) {
    this.resultsContainer.empty();
    const errEl = this.resultsContainer.createEl("div", { cls: "qmd-error" });
    // 줄바꿈 포함 메시지를 개별 단락으로 표시
    for (const line of msg.split("\n")) {
      if (line.trim()) errEl.createEl("p", { text: line.trim() });
    }
  }

  /**
   * 결과 카드를 순차 렌더링한다.
   * 많은 결과가 한 번에 들어와도 주기적으로 event loop를 비워 UI 멈춤을 줄이고,
   * 더 최근 검색이 시작되면 renderGeneration 비교로 오래된 렌더를 중단한다.
   */
  private async showResults(results: QmdResult[], renderId: number) {
    this.resultsContainer.empty();

    if (results.length === 0) {
      this.showEmpty("검색 결과가 없습니다");
      return;
    }

    if (this.plugin.shouldLog("DEBUG")) {
      console.group("QMD 검색 결과");
      results.forEach((r, i) => {
        console.log(`#${i + 1}`, {
          file: r.file,
          collection: r.collection,
          relativePath: r.relativePath,
          title: r.title
        });
      });
      console.groupEnd();
    }

    for (let i = 0; i < results.length; i++) {
      if (renderId !== this.renderGeneration) return;
      const result = results[i];
      this.renderResultCard(result);
      if ((i + 1) % 25 === 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
  }

  private renderResultCard(result: QmdResult) {
    const card = this.resultsContainer.createEl("div", { cls: "qmd-result-card" });

    // 헤더: 점수 + 제목
    const header = card.createEl("div", { cls: "qmd-result-header" });

    if (result.score !== undefined) {
      header.createEl("span", {
        cls: "qmd-score-badge",
        text: (result.score * 100).toFixed(0) + "%",
      });
    }

    const title = result.title || this.extractFilename(result.relativePath);
    header.createEl("span", { cls: "qmd-result-title", text: title });

    // 경로
    card.createEl("div", {
      cls: "qmd-result-path",
      text: `[${result.collection}] ${result.relativePath}`,
    });

    // 스니펫 (diff 형식에서 실제 내용만 추출)
    if (result.snippet) {
      const cleanSnippet = this.cleanSnippet(result.snippet);
      if (cleanSnippet) {
        card.createEl("div", { cls: "qmd-result-snippet", text: cleanSnippet });
      }
    }

    // 클릭 → 파일 열기
    card.addEventListener("click", () => this.openResult(result));
  }

  private extractFilename(relativePath: string): string {
    const parts = relativePath.split("/");
    return (parts[parts.length - 1] || relativePath).replace(/\.md$/i, "");
  }

  private cleanSnippet(snippet: string): string {
    // "@@ -N,N @@ ..." 헤더 제거, 내용만 추출
    return snippet
      .replace(/@@ [^@]+ @@[^\n]*/g, "")
      .trim()
      .substring(0, 200);
  }

  /** qmd가 파일명을 소문자/하이픈 쪽으로 정규화해 저장하므로, 볼트 파일도 같은 기준으로 색인한다. */
  private normalizeFuzzyPath(path: string): string {
    return path.toLowerCase().replace(/_/g, "-");
  }

  private invalidateFuzzyPathIndex() {
    this.fuzzyPathIndex = null;
  }

  /** 퍼지 경로 인덱스는 결과 열기 시점에만 지연 생성하고, 첫 동일 키만 보존해 결정성을 유지한다. */
  private ensureFuzzyPathIndex() {
    if (this.fuzzyPathIndex) return;
    const index = new Map<string, TFile>();
    for (const file of this.app.vault.getFiles()) {
      const key = this.normalizeFuzzyPath(file.path);
      if (!index.has(key)) {
        index.set(key, file);
      }
    }
    this.fuzzyPathIndex = index;
  }

  /**
   * qmd는 경로를 정규화(소문자 + '_'→'-')하여 저장하므로,
   * 정확한 경로 매칭 실패 시 볼트 전체 파일 목록에서 퍼지 매칭으로 실제 파일을 찾는다.
   */
  private findFileByFuzzyPath(vaultRelativePath: string): TFile | null {
    // 정확한 경로로 먼저 시도
    const exact = this.app.vault.getAbstractFileByPath(vaultRelativePath);
    if (exact instanceof TFile) return exact;

    // qmd 정규화 역변환: 소문자 통일 + '_' == '-' 동일 취급
    const target = this.normalizeFuzzyPath(vaultRelativePath);
    this.ensureFuzzyPathIndex();
    const cached = this.fuzzyPathIndex?.get(target);
    if (cached) return cached;

    // 캐시가 오래되어 놓친 rename/create를 한 번 더 복구하기 위해 재색인을 재시도한다.
    this.invalidateFuzzyPathIndex();
    this.ensureFuzzyPathIndex();
    return this.fuzzyPathIndex?.get(target) ?? null;
  }

  /**
   * 검색 결과를 현재 볼트의 실제 파일로 연다.
   * 다른 볼트 컬렉션이거나 경로 매핑이 없으면 null/Notice로 처리하고, 직접 파일 열기까지는 진행하지 않는다.
   */
  private async openResult(result: QmdResult) {
    let vaultRoot = "";
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      vaultRoot = this.app.vault.adapter.getBasePath();
    } else {
      // Fallback for non-filesystem adapters (less likely on desktop)
      // @ts-ignore
      vaultRoot = this.app.vault.adapter.basePath || "";
    }

    const vaultPath = this.plugin.executor.resolveToVaultRelativePath(result, vaultRoot);

    if (!vaultPath) {
      const collBase = this.plugin.settings.collectionPaths[result.collection];
      if (collBase) {
        new Notice(`다른 볼트의 파일입니다:\n컬렉션: ${result.collection}\n경로: ${collBase}/${result.relativePath}`);
      } else {
        new Notice(
          `컬렉션 '${result.collection}'의 경로가 설정되지 않았습니다.\n설정 > QMD Bridge에서 'config에서 로드'를 클릭하세요.`
        );
      }
      return;
    }

    const normalizedVaultPath = normalizePath(vaultPath);
    const file = this.findFileByFuzzyPath(normalizedVaultPath);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    } else {
      new Notice(`볼트 내에서 파일을 찾을 수 없습니다.\n상대경로: ${normalizedVaultPath}`);
      this.plugin.log("WARN", "QMD 파일 열기 실패:", { normalizedVaultPath, result, vaultRoot });
    }
  }

  async onClose() {
    this.invalidateFuzzyPathIndex();
    this.renderGeneration += 1;
  }
}
