import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { QmdBridgeSettings, QmdBridgeSettingTab, DEFAULT_SETTINGS } from "./settings";
import { QmdExecutor } from "./qmd-executor";
import { QmdSearchView, SEARCH_VIEW_TYPE } from "./search-view";
import { ProgressModal } from "./modals/progress-modal";
import { StatusModal } from "./modals/status-modal";
import { CollectionModal } from "./modals/collection-modal";

/**
 * 플러그인 엔트리 포인트.
 *
 * 흐름 개요:
 * onload
 *   -> 설정 로드
 *   -> QmdExecutor 생성
 *   -> 검색 뷰 / 명령 / 리본 / 설정 탭 등록
 * 사용자 액션
 *   -> search view 열기
 *   -> qmd update/embed/status/collection 실행
 *   -> modal 또는 side view로 결과 전달
 * 설정 저장
 *   -> executor 갱신
 *   -> 이미 열린 search view 옵션 재동기화
 */
type ReportStats = {
  warnings: number;
  errors: number;
  processedFiles: Set<string>;
  succeededFiles: Set<string>;
  failedFiles: Set<string>;
};

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

  /** 레이아웃 준비 이후 확장 포인트를 남겨 두되, 현재는 자동으로 검색 패널을 열지 않는다. */
  private async initView() {
    // 이미 열려 있으면 skip
    const existing = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
    if (existing.length === 0) {
      // 첫 로드 시 자동으로 열지 않음 (사용자가 명령/아이콘으로 열도록)
    }
  }

  /**
   * 검색 패널을 재사용 가능한 단일 사이드 리프로 유지한다.
   * 이미 열려 있으면 해당 리프를 노출하고, 없으면 오른쪽 패널에 새로 만든다.
   */
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

  /** update 명령은 중복 실행을 막고, 스트리밍 로그와 최종 요약을 ProgressModal에 누적한다. */
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
    const reportStats = this.createReportStats();

    this.executor.runStreamingCommand(
      command,
      (line) => {
        this.accumulateReportLine(reportStats, line);
        modal.appendLine(line);
      },
      (err) => {
        modal.appendLine(`오류: ${err.message}`);
        modal.finish(1, this.buildReportSummary(command[0], startedAt, reportStats, 1));
        this.updateRunning = false;
      },
      (code) => {
        modal.finish(code, this.buildReportSummary(command[0], startedAt, reportStats, code));
        this.updateRunning = false;
      }
    );
  }

  /** embed 명령도 update와 같은 제어 흐름을 따르되 별도 실행 플래그를 사용한다. */
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
    const reportStats = this.createReportStats();

    this.executor.runStreamingCommand(
      command,
      (line) => {
        this.accumulateReportLine(reportStats, line);
        modal.appendLine(line);
      },
      (err) => {
        modal.appendLine(`오류: ${err.message}`);
        modal.finish(1, this.buildReportSummary(command[0], startedAt, reportStats, 1));
        this.embedRunning = false;
      },
      (code) => {
        modal.finish(code, this.buildReportSummary(command[0], startedAt, reportStats, code));
        this.embedRunning = false;
      }
    );
  }

  /** dry-run 여부를 포함한 현재 플러그인 로그 기준을 다른 컴포넌트와 공유한다. */
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

  /**
   * 실제 qmd 실행 대신 "무엇이 실행될지"만 모달에 기록한다.
   * 실행기 환경과 동일하게 forceCpu/logLevel 표시 규칙을 맞춰 dry-run 설명과 실제 동작이 어긋나지 않게 한다.
   */
  private renderDryRun(modal: ProgressModal, operationName: string, command: string[]) {
    modal.appendLine("[DRY-RUN] 실제 변환은 실행되지 않습니다.");
    modal.appendLine("[DRY-RUN] 실행 예정 작업:");
    modal.appendLine(`- 명령: ${this.settings.qmdPath} ${command.join(" ")}`);
    if (this.settings.forceCpu) {
      modal.appendLine("- QMD_FORCE_CPU=1");
    }
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

  /** 스트리밍 로그를 요약하기 위한 카운터/집합을 작업마다 새로 만든다. */
  private createReportStats(): ReportStats {
    return {
      warnings: 0,
      errors: 0,
      processedFiles: new Set<string>(),
      succeededFiles: new Set<string>(),
      failedFiles: new Set<string>(),
    };
  }

  /**
   * qmd 로그 한 줄에서 파일처럼 보이는 토큰을 느슨하게 추출한다.
   * 형식이 고정돼 있지 않아 따옴표 경로 -> 슬래시 포함 경로 -> 확장자 포함 토큰 순으로 완화한다.
   */
  private extractFileToken(line: string): string | null {
    const quoted = line.match(/["'`]([^"'`]+)["'`]/);
    if (quoted && /[\/\\.]|qmd:\/\//i.test(quoted[1])) return quoted[1];

    const withSlash = line.match(/(?:^|\s)([^\s"'`]*[\/\\][^\s"'`]+)(?=\s|$)/);
    if (withSlash) return withSlash[1];

    const dotted = line.match(/(?:^|\s)([^\s"'`]+\.[a-zA-Z0-9]{1,8})(?=\s|$)/);
    if (dotted) return dotted[1];

    return null;
  }

  /**
   * 진행 로그 한 줄을 요약 통계에 반영한다.
   * 같은 파일이 성공 후 실패로 뒤집히는 경우가 있어, 최종 집계는 succeeded/failed 집합을 분리해 계산한다.
   */
  private accumulateReportLine(reportStats: ReportStats, line: string): void {
    const warningRe = /\bwarn(?:ing)?\b|경고/i;
    const errorRe = /\berror\b|오류/i;
    const failureRe = /\bfail(?:ed)?\b|실패/i;
    const successRe = /\bok\b|\bdone\b|\bsuccess\b|\bprocessed\b|\bindexed\b|\bembedded\b|\bupdated\b|성공|완료|처리됨|업데이트됨|임베딩됨/i;

    const hasError = errorRe.test(line);
    const hasWarning = warningRe.test(line);
    const hasFailure = failureRe.test(line) || errorRe.test(line);
    const hasSuccess = successRe.test(line);

    if (hasWarning) reportStats.warnings += 1;
    if (hasError) reportStats.errors += 1;

    const fileToken = this.extractFileToken(line);
    if (!fileToken || (!hasSuccess && !hasFailure)) return;

    reportStats.processedFiles.add(fileToken);
    if (hasFailure) {
      reportStats.failedFiles.add(fileToken);
    } else if (hasSuccess) {
      reportStats.succeededFiles.add(fileToken);
    }
  }

  /**
   * ProgressModal 마지막에 붙일 요약 문자열을 만든다.
   * 파일 단위 로그가 전혀 없는 실패는 집계상 0건으로 보이지 않도록 최소 실패 1건으로 보정한다.
   */
  private buildReportSummary(commandName: string, startedAt: number, reportStats: ReportStats, code: number): string {
    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(2);
    let succeededWithoutFailures = 0;
    for (const file of reportStats.succeededFiles) {
      if (!reportStats.failedFiles.has(file)) {
        succeededWithoutFailures += 1;
      }
    }
    let succeededCount = reportStats.processedFiles.size > 0 ? succeededWithoutFailures : 0;
    let failedCount = reportStats.processedFiles.size > 0 ? reportStats.failedFiles.size : 0;
    let errorCount = reportStats.errors;

    if (code !== 0 && reportStats.processedFiles.size === 0) {
      failedCount = 1;
      succeededCount = 0;
      errorCount = Math.max(1, errorCount);
    }

    return [
      "=== 변환 보고서 요약 ===",
      `작업: ${commandName}`,
      `처리된 파일 수: ${reportStats.processedFiles.size}`,
      `성공한 변환: ${succeededCount}`,
      `실패한 변환: ${failedCount}`,
      `경고: ${reportStats.warnings}`,
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

  /**
   * 저장된 설정을 디스크에 기록한 뒤, 런타임 의존 객체도 즉시 같은 값으로 맞춘다.
   * 이미 열린 검색 뷰를 닫지 않고 컬렉션 드롭다운만 새 설정으로 갱신하는 것이 핵심이다.
   */
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
