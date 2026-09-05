import { App, Modal } from "obsidian";

/**
 * update/embed처럼 장시간 실행되는 qmd 명령의 진행 로그를 누적 표시한다.
 *
 * 흐름 개요:
 * onOpen -> 비활성화된 닫기 버튼 + 로그 영역 생성
 * appendLine -> 스트리밍 로그 추가 및 자동 스크롤
 * finish -> 요약/종료 상태 표시 후 닫기 버튼 활성화
 */
export class ProgressModal extends Modal {
  private logEl: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private isDone = false;
  title: string;

  constructor(app: App, title: string) {
    super(app);
    this.title = title;
  }

  /** 작업 완료 전에는 사용자가 중간 상태를 오해하지 않도록 닫기 버튼을 비활성화한 채 연다. */
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("qmd-modal-large");
    contentEl.empty();

    contentEl.createEl("h3", { text: this.title });

    this.logEl = contentEl.createEl("div", { cls: "qmd-progress-log" });
    this.logEl.setText("시작 중...\n");

    this.closeBtn = contentEl.createEl("button", {
      text: "닫기",
      cls: "mod-cta",
    });
    this.closeBtn.disabled = true;
    this.closeBtn.style.marginTop = "8px";
    this.closeBtn.addEventListener("click", () => this.close());
  }

  /** 로그는 textContent에만 누적해 ANSI/HTML 해석 없이 원문 순서를 그대로 보여준다. */
  appendLine(line: string) {
    this.logEl.textContent += line + "\n";
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** summary가 있으면 종료 상태 앞에 붙여 한 화면에서 로그와 집계를 모두 확인할 수 있게 한다. */
  finish(code: number, summary?: string) {
    this.isDone = true;
    if (summary) {
      this.appendLine("");
      this.appendLine(summary);
    }
    if (code === 0) {
      this.appendLine("\n✓ 완료");
    } else {
      this.appendLine(`\n✗ 오류 발생 (종료 코드: ${code})`);
    }
    this.closeBtn.disabled = false;
    this.closeBtn.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}
