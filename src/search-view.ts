import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type QmdBridgePlugin from "./main";
import type { QmdResult } from "./qmd-executor";

export const SEARCH_VIEW_TYPE = "qmd-search-view";

export class QmdSearchView extends ItemView {
  plugin: QmdBridgePlugin;
  private searchInput: HTMLInputElement;
  private typeSelect: HTMLSelectElement;
  private collectionSelect: HTMLSelectElement;
  private limitInput: HTMLInputElement;
  private resultsContainer: HTMLElement;

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
  }

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

    this.showLoading();

    try {
      let results: QmdResult[];
      if (type === "bm25") {
        results = await this.plugin.executor.search(query, collection, limit);
      } else if (type === "vector") {
        results = await this.plugin.executor.vsearch(query, collection, limit);
      } else {
        results = await this.plugin.executor.deepQuery(query, collection, limit);
      }
      this.showResults(results);
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
    this.resultsContainer.createEl("div", {
      cls: "qmd-error",
      text: `오류: ${msg}`,
    });
  }

  private showResults(results: QmdResult[]) {
    this.resultsContainer.empty();

    if (results.length === 0) {
      this.showEmpty("검색 결과가 없습니다");
      return;
    }

    for (const result of results) {
      this.renderResultCard(result);
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

  private async openResult(result: QmdResult) {
    // @ts-ignore
    const vaultRoot: string = (this.app.vault.adapter as any).basePath;
    const vaultPath = this.plugin.executor.resolveToVaultRelativePath(result, vaultRoot);

    if (!vaultPath) {
      const collBase = this.plugin.settings.collectionPaths[result.collection];
      if (collBase) {
        new Notice(`다른 볼트의 파일:\n${collBase}/${result.relativePath}`);
      } else {
        new Notice(
          `컬렉션 '${result.collection}' 경로가 설정되지 않았습니다.\n설정 > QMD Bridge에서 경로를 추가하세요.`
        );
      }
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    } else {
      new Notice(`파일을 찾을 수 없습니다: ${vaultPath}`);
    }
  }

  async onClose() {
    // cleanup
  }
}
