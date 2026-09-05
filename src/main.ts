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
  private updateRunning = false;
  private embedRunning = false;
  private static readonly LOG_LEVEL_ORDER = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 } as const;

  async onload() {
    await this.loadSettings();

    this.executor = new QmdExecutor(
      this.settings.qmdPath,
      this.settings.collectionPaths,
      this.settings.forceCpu,
      this.settings.dryRun,
      this.settings.logLevel
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
    if (this.updateRunning) {
      new Notice("QMD 인덱스 업데이트가 이미 실행 중입니다.");
      return;
    }

    this.updateRunning = true;
    const modal = new ProgressModal(this.app, "QMD 인덱스 업데이트");
    modal.open();

    const command = ["update"];
    if (this.settings.dryRun) {
      this.renderDryRun(modal, command[0], command);
      this.updateRunning = false;
      return;
    }

    const startedAt = Date.now();
    const lines: string[] = [];

    this.executor.runStreamingCommand(
      command,
      (line) => {
        lines.push(line);
        modal.appendLine(line);
      },
      (err) => {
        modal.appendLine(`오류: ${err.message}`);
        modal.finish(1, this.buildReportSummary(command[0], startedAt, lines, 1));
        this.updateRunning = false;
      },
      (code) => {
        modal.finish(code, this.buildReportSummary(command[0], startedAt, lines, code));
        this.updateRunning = false;
      }
    );
  }

  runEmbed() {
    if (this.embedRunning) {
      new Notice("QMD 임베딩 생성이 이미 실행 중입니다.");
      return;
    }

    this.embedRunning = true;
    const modal = new ProgressModal(this.app, "QMD 임베딩 생성");
    modal.open();

    const command = ["embed"];
    if (this.settings.dryRun) {
      this.renderDryRun(modal, command[0], command);
      this.embedRunning = false;
      return;
    }

    const startedAt = Date.now();
    const lines: string[] = [];

    this.executor.runStreamingCommand(
      command,
      (line) => {
        lines.push(line);
        modal.appendLine(line);
      },
      (err) => {
        modal.appendLine(`오류: ${err.message}`);
        modal.finish(1, this.buildReportSummary(command[0], startedAt, lines, 1));
        this.embedRunning = false;
      },
      (code) => {
        modal.finish(code, this.buildReportSummary(command[0], startedAt, lines, code));
        this.embedRunning = false;
      }
    );
  }

  shouldLog(level: "ERROR" | "WARN" | "INFO" | "DEBUG"): boolean {
    return QmdBridgePlugin.LOG_LEVEL_ORDER[level] <= QmdBridgePlugin.LOG_LEVEL_ORDER[this.settings.logLevel];
  }

  log(level: "ERROR" | "WARN" | "INFO" | "DEBUG", ...args: unknown[]) {
    if (!this.shouldLog(level)) return;
    if (level === "ERROR") {
      console.error(...args);
    } else if (level === "WARN") {
      console.warn(...args);
    } else {
      console.log(...args);
    }
  }

  private renderDryRun(modal: ProgressModal, operationName: string, command: string[]) {
    modal.appendLine("[DRY-RUN] 실제 변환은 실행되지 않습니다.");
    modal.appendLine("[DRY-RUN] 실행 예정 작업:");
    modal.appendLine(`- 명령: ${this.settings.qmdPath} ${command.join(" ")}`);
    modal.appendLine(`- QMD_FORCE_CPU=${this.settings.forceCpu ? "1" : "0"}`);
    modal.appendLine(`- QMD_LOG_LEVEL=${this.settings.logLevel.toLowerCase()}`);
    modal.finish(
      0,
      [
        "=== 변환 보고서 요약 ===",
        `작업: ${operationName}`,
        "모드: DRY-RUN",
        "처리된 파일 수: 0",
        "성공한 변환: 0",
        "실패한 변환: 0",
        "경고: 0",
        "오류: 0",
        "실행 시간: 0.00초",
      ].join("\n")
    );
  }

  private buildReportSummary(commandName: string, startedAt: number, lines: string[], code: number): string {
    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(2);
    const warningRe = /\bwarn(?:ing)?\b|경고/i;
    const errorRe = /\berror\b|오류/i;
    const failureRe = /\bfail(?:ed)?\b|실패/i;
    const successRe = /\bok\b|\bdone\b|\bsuccess\b|\bprocessed\b|\bindexed\b|\bembedded\b|\bupdated\b|성공|완료|처리됨|업데이트됨|임베딩됨/i;

    let warnings = 0;
    let errors = 0;
    const processedFiles = new Set<string>();
    const succeededFiles = new Set<string>();
    const failedFiles = new Set<string>();

    const extractFileToken = (line: string): string | null => {
      const quoted = line.match(/["'`]([^"'`]+)["'`]/);
      if (quoted && /[\/\\.]|qmd:\/\//i.test(quoted[1])) return quoted[1];

      const withSlash = line.match(/(?:^|\s)([^\s"'`]*[\/\\][^\s"'`]+)(?=\s|$)/);
      if (withSlash) return withSlash[1];

      const dotted = line.match(/(?:^|\s)([^\s"'`]+\.[a-zA-Z0-9]{1,8})(?=\s|$)/);
      if (dotted) return dotted[1];

      return null;
    };

    for (const line of lines) {
      const hasError = errorRe.test(line) || failureRe.test(line);
      const hasWarning = warningRe.test(line);
      const hasFailure = failureRe.test(line) || errorRe.test(line);
      const hasSuccess = successRe.test(line);

      if (hasWarning) warnings += 1;
      if (hasError) errors += 1;

      const fileToken = extractFileToken(line);
      if (!fileToken || (!hasSuccess && !hasFailure)) continue;
      processedFiles.add(fileToken);
      if (hasFailure) {
        failedFiles.add(fileToken);
      } else if (hasSuccess) {
        succeededFiles.add(fileToken);
      }
    }

    const succeededWithoutFailures = [...succeededFiles].filter((file) => !failedFiles.has(file)).length;
    let succeededCount = processedFiles.size > 0 ? succeededWithoutFailures : 0;
    let failedCount = processedFiles.size > 0 ? failedFiles.size : 0;
    let errorCount = errors;

    if (code !== 0 && failedCount === 0) {
      failedCount = 1;
      succeededCount = 0;
      errorCount = Math.max(1, errorCount);
    }

    return [
      "=== 변환 보고서 요약 ===",
      `작업: ${commandName}`,
      `처리된 파일 수: ${processedFiles.size}`,
      `성공한 변환: ${succeededCount}`,
      `실패한 변환: ${failedCount}`,
      `경고: ${warnings}`,
      `오류: ${errorCount}`,
      `실행 시간: ${durationSec}초`,
    ].join("\n");
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
      this.executor.updateSettings(
        this.settings.qmdPath,
        this.settings.collectionPaths,
        this.settings.forceCpu,
        this.settings.dryRun,
        this.settings.logLevel
      );
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
