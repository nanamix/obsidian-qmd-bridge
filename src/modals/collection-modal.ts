import { App, Modal } from "obsidian";

export class CollectionModal extends Modal {
  private content: string;

  constructor(app: App, content: string) {
    super(app);
    this.content = content;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "QMD 컬렉션 목록" });

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
