import { App, Modal } from "obsidian";

/** qmd collection list의 원문 출력을 간단히 확인하는 읽기 전용 모달이다. */
export class CollectionModal extends Modal {
  private content: string;

  constructor(app: App, content: string) {
    super(app);
    this.content = content;
  }

  /** 컬렉션 목록도 status와 같은 패턴을 사용해 출력 차이를 최소화한다. */
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
