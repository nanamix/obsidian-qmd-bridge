import { App, Modal } from "obsidian";

/** qmd status의 원문 출력을 읽기 전용 pre 블록으로 보여주는 단순 모달이다. */
export class StatusModal extends Modal {
  private content: string;

  constructor(app: App, content: string) {
    super(app);
    this.content = content;
  }

  /** 상태 출력은 포맷 손실 없이 보여야 하므로 별도 파싱 없이 그대로 pre.textContent에 넣는다. */
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("qmd-modal-large");
    contentEl.empty();
    contentEl.createEl("h3", { text: "QMD 상태" });

    const pre = contentEl.createEl("pre", { cls: "qmd-status-content" });
    pre.textContent = this.content;

    const btn = contentEl.createEl("button", { text: "닫기", cls: "mod-cta" });
    btn.style.marginTop = "8px";
    btn.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
