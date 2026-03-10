import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type QmdBridgePlugin from "./main";

export interface QmdBridgeSettings {
  qmdPath: string;
  defaultSearchType: "bm25" | "vector" | "deep";
  defaultResultCount: number;
  defaultCollection: string;
  collectionPaths: { [collection: string]: string };
}

export const DEFAULT_SETTINGS: QmdBridgeSettings = {
  qmdPath: "/Users/jinyoungha/.asdf/shims/qmd",
  defaultSearchType: "bm25",
  defaultResultCount: 10,
  defaultCollection: "obsidian",
  collectionPaths: {},
};

export class QmdBridgeSettingTab extends PluginSettingTab {
  plugin: QmdBridgePlugin;

  constructor(app: App, plugin: QmdBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "QMD Bridge 설정" });

    // qmd 실행 파일 경로
    new Setting(containerEl)
      .setName("qmd 실행 파일 경로")
      .setDesc("qmd 바이너리의 절대 경로")
      .addText((text) =>
        text
          .setPlaceholder("/usr/local/bin/qmd")
          .setValue(this.plugin.settings.qmdPath)
          .onChange(async (value) => {
            this.plugin.settings.qmdPath = value;
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("테스트")
          .setCta()
          .onClick(async () => {
            const ok = await this.plugin.executor.testConnection();
            if (ok) {
              new Notice("✓ qmd 연결 성공!");
            } else {
              new Notice("✗ qmd 연결 실패. 경로를 확인하세요.");
            }
          })
      );

    // 기본 검색 타입
    new Setting(containerEl)
      .setName("기본 검색 타입")
      .setDesc("검색 패널의 기본 검색 방식")
      .addDropdown((drop) =>
        drop
          .addOption("bm25", "BM25 (키워드)")
          .addOption("vector", "Vector (의미)")
          .addOption("deep", "Deep (심층)")
          .setValue(this.plugin.settings.defaultSearchType)
          .onChange(async (value) => {
            this.plugin.settings.defaultSearchType = value as "bm25" | "vector" | "deep";
            await this.plugin.saveSettings();
          })
      );

    // 기본 결과 수
    new Setting(containerEl)
      .setName("기본 결과 수")
      .setDesc("검색 결과 최대 개수")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.defaultResultCount))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.defaultResultCount = num;
              await this.plugin.saveSettings();
            }
          })
      );

    // 기본 컬렉션
    new Setting(containerEl)
      .setName("기본 컬렉션")
      .setDesc("검색할 기본 컬렉션 이름 (빈 값 = 전체)")
      .addText((text) =>
        text
          .setPlaceholder("obsidian")
          .setValue(this.plugin.settings.defaultCollection)
          .onChange(async (value) => {
            this.plugin.settings.defaultCollection = value;
            await this.plugin.saveSettings();
          })
      );

    // 컬렉션 경로 매핑
    containerEl.createEl("h3", { text: "컬렉션 경로 매핑" });
    containerEl.createEl("p", {
      text: "컬렉션 이름과 볼트 내 경로를 매핑합니다. 파일을 클릭하여 열 때 사용됩니다.",
      cls: "setting-item-description",
    });

    // "config에서 로드" 버튼
    new Setting(containerEl)
      .setName("자동 로드")
      .setDesc("~/.config/qmd/index.yml에서 컬렉션 경로를 자동으로 가져옵니다")
      .addButton((btn) =>
        btn
          .setButtonText("config에서 로드")
          .setCta()
          .onClick(async () => {
            const paths = await this.plugin.executor.parseQmdConfig();
            if (Object.keys(paths).length === 0) {
              new Notice("컬렉션 정보를 가져오지 못했습니다.");
              return;
            }
            this.plugin.settings.collectionPaths = paths;
            await this.plugin.saveSettings();
            new Notice(`${Object.keys(paths).length}개의 컬렉션 경로를 로드했습니다.`);
            this.display();
          })
      );

    // 컬렉션 매핑 테이블
    const tableEl = containerEl.createEl("table", { cls: "qmd-settings-table" });
    const thead = tableEl.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "컬렉션" });
    headerRow.createEl("th", { text: "절대 경로" });
    headerRow.createEl("th", { text: "" });

    const tbody = tableEl.createEl("tbody");

    const renderRows = () => {
      tbody.empty();
      const paths = this.plugin.settings.collectionPaths;
      for (const [name, colPath] of Object.entries(paths)) {
        const row = tbody.createEl("tr");
        const nameCell = row.createEl("td");
        nameCell.createEl("input", {
          type: "text",
          value: name,
          attr: { style: "width:100%; font-size:12px;" },
        }).addEventListener("change", async (e) => {
          const newName = (e.target as HTMLInputElement).value.trim();
          if (newName && newName !== name) {
            const val = this.plugin.settings.collectionPaths[name];
            delete this.plugin.settings.collectionPaths[name];
            this.plugin.settings.collectionPaths[newName] = val;
            await this.plugin.saveSettings();
          }
        });

        const pathCell = row.createEl("td");
        pathCell.createEl("input", {
          type: "text",
          value: colPath,
          attr: { style: "width:100%; font-size:12px;" },
        }).addEventListener("change", async (e) => {
          this.plugin.settings.collectionPaths[name] = (e.target as HTMLInputElement).value.trim();
          await this.plugin.saveSettings();
        });

        const actionCell = row.createEl("td");
        actionCell
          .createEl("button", { text: "삭제" })
          .addEventListener("click", async () => {
            delete this.plugin.settings.collectionPaths[name];
            await this.plugin.saveSettings();
            renderRows();
          });
      }
    };

    renderRows();

    // 새 항목 추가
    const addSetting = new Setting(containerEl);
    addSetting.setName("새 컬렉션 추가").addButton((btn) =>
      btn.setButtonText("+ 추가").onClick(async () => {
        this.plugin.settings.collectionPaths["새컬렉션"] = "/path/to/vault";
        await this.plugin.saveSettings();
        renderRows();
      })
    );
  }
}
