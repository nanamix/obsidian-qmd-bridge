import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { QmdBridgeSettings, QmdBridgeSettingTab, DEFAULT_SETTINGS } from "./settings";
import { QmdExecutor } from "./qmd-executor";
import { QmdSearchView, SEARCH_VIEW_TYPE } from "./search-view";
import { ProgressModal } from "./modals/progress-modal";
import { StatusModal } from "./modals/status-modal";
import { CollectionModal } from "./modals/collection-modal";

export default class QmdBridgePlugin extends Plugin {
  settings: QmdBridgeSettings;
  executor: QmdExecutor;

  async onload() {
    await this.loadSettings();

    this.executor = new QmdExecutor(
      this.settings.qmdPath,
      this.settings.collectionPaths
    );

    // 사이드바 뷰 등록
    this.registerView(SEARCH_VIEW_TYPE, (leaf) => new QmdSearchView(leaf, this));

    // 리본 아이콘
    this.addRibbonIcon("search", "QMD Search 열기", () => {
      this.activateSearchView();
    });

    // 명령 등록
    this.addCommand({
      id: "open-search-panel",
      name: "검색 패널 열기",
      callback: () => this.activateSearchView(),
    });

    this.addCommand({
      id: "update-index",
      name: "인덱스 업데이트 (qmd update)",
      callback: () => this.runUpdate(),
    });

    this.addCommand({
      id: "create-embeddings",
      name: "임베딩 생성 (qmd embed)",
      callback: () => this.runEmbed(),
    });

    this.addCommand({
      id: "show-status",
      name: "QMD 상태 보기",
      callback: () => this.showStatus(),
    });

    this.addCommand({
      id: "list-collections",
      name: "컬렉션 목록 보기",
      callback: () => this.showCollections(),
    });

    // 설정 탭
    this.addSettingTab(new QmdBridgeSettingTab(this.app, this));

    // 시작 시 검색 뷰 자동 열기 (선택적)
    this.app.workspace.onLayoutReady(() => {
      this.initView();
    });
  }

  private async initView() {
    // 이미 열려 있으면 skip
    const existing = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
    if (existing.length === 0) {
      // 첫 로드 시 자동으로 열지 않음 (사용자가 명령/아이콘으로 열도록)
    }
  }

  async activateSearchView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(SEARCH_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: SEARCH_VIEW_TYPE,
          active: true,
        });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  runUpdate() {
    const modal = new ProgressModal(this.app, "QMD 인덱스 업데이트");
    modal.open();

    this.executor.runStreamingCommand(
      ["update"],
      (line) => modal.appendLine(line),
      (err) => {
        modal.appendLine(`오류: ${err.message}`);
        modal.finish(1);
      },
      (code) => modal.finish(code)
    );
  }

  runEmbed() {
    const modal = new ProgressModal(this.app, "QMD 임베딩 생성");
    modal.open();

    this.executor.runStreamingCommand(
      ["embed"],
      (line) => modal.appendLine(line),
      (err) => {
        modal.appendLine(`오류: ${err.message}`);
        modal.finish(1);
      },
      (code) => modal.finish(code)
    );
  }

  async showStatus() {
    try {
      const output = await this.executor.status();
      new StatusModal(this.app, output).open();
    } catch (e) {
      new Notice(`상태 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async showCollections() {
    try {
      const output = await this.executor.listCollections();
      new CollectionModal(this.app, output).open();
    } catch (e) {
      new Notice(`컬렉션 목록 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(SEARCH_VIEW_TYPE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // executor 설정 업데이트
    if (this.executor) {
      this.executor.updateSettings(this.settings.qmdPath, this.settings.collectionPaths);
    }
    // 검색 뷰 컬렉션 옵션 갱신
    const leaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof QmdSearchView) {
        leaf.view.updateCollectionOptions();
      }
    }
  }
}
