import { App, Modal } from "obsidian";

export class ProgressModal extends Modal {
  private logEl: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private isDone = false;
  title: string;

  constructor(app: App, title: string) {
    super(app);
    this.title = title;
  }

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

  appendLine(line: string) {
    this.logEl.textContent += line + "\n";
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  finish(code: number) {
    this.isDone = true;
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
