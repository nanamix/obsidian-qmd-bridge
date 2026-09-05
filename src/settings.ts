import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type QmdBridgePlugin from "./main";

export interface QmdBridgeSettings {
  qmdPath: string;
  forceCpu: boolean;
  dryRun: boolean;
  logLevel: "ERROR" | "WARN" | "INFO" | "DEBUG";
  defaultSearchType: "bm25" | "vector" | "deep";
  defaultResultCount: number;
  defaultCollection: string;
  collectionPaths: { [collection: string]: string };
}

export const DEFAULT_SETTINGS: QmdBridgeSettings = {
  qmdPath: "qmd",
  forceCpu: true,
  dryRun: false,
  logLevel: "WARN",
  defaultSearchType: "bm25",
  defaultResultCount: 10,
  defaultCollection: "obsidian",
  collectionPaths: {},
};

export class QmdBridgeSettingTab extends PluginSettingTab {
  plugin: QmdBridgePlugin;
  private saveDebounceTimer: number | null = null;

  constructor(app: App, plugin: QmdBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private scheduleSaveSettings(delayMs = 250): void {
    if (this.saveDebounceTimer !== null) {
      window.clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = window.setTimeout(() => {
      this.saveDebounceTimer = null;
      void this.plugin.saveSettings();
    }, delayMs);
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
            if (this.plugin.settings.qmdPath === value) return;
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

    new Setting(containerEl)
      .setName("CPU 모드 강제")
      .setDesc("Metal 백엔드 오류가 있을 때 qmd 실행에 QMD_FORCE_CPU=1을 적용합니다")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.forceCpu)
          .onChange(async (value) => {
            if (this.plugin.settings.forceCpu === value) return;
            this.plugin.settings.forceCpu = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Dry-run 모드")
      .setDesc("실제 업데이트/임베딩 실행 없이 수행 예정 작업만 표시합니다")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.dryRun)
          .onChange(async (value) => {
            if (this.plugin.settings.dryRun === value) return;
            this.plugin.settings.dryRun = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("로그 레벨")
      .setDesc("로그 상세도 (기본: WARN)")
      .addDropdown((drop) =>
        drop
          .addOption("ERROR", "ERROR")
          .addOption("WARN", "WARN")
          .addOption("INFO", "INFO")
          .addOption("DEBUG", "DEBUG")
          .setValue(this.plugin.settings.logLevel)
          .onChange(async (value) => {
            const next = value as "ERROR" | "WARN" | "INFO" | "DEBUG";
            if (this.plugin.settings.logLevel === next) return;
            this.plugin.settings.logLevel = next;
            await this.plugin.saveSettings();
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
            const next = value as "bm25" | "vector" | "deep";
            if (this.plugin.settings.defaultSearchType === next) return;
            this.plugin.settings.defaultSearchType = next;
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
          .onChange((value) => {
            const num = parseInt(value);
            if (isNaN(num) || num <= 0) return;
            if (this.plugin.settings.defaultResultCount === num) return;
            this.plugin.settings.defaultResultCount = num;
            this.scheduleSaveSettings();
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
          .onChange((value) => {
            if (this.plugin.settings.defaultCollection === value) return;
            this.plugin.settings.defaultCollection = value;
            this.scheduleSaveSettings();
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

    const createRow = (initialName: string, initialPath: string) => {
      const row = tbody.createEl("tr");
      let currentName = initialName;

      const nameCell = row.createEl("td");
      const nameInput = nameCell.createEl("input", {
        type: "text",
        value: currentName,
        attr: { style: "width:100%; font-size:12px;" },
      });
      nameInput.addEventListener("change", async (e) => {
        const newName = (e.target as HTMLInputElement).value.trim();
        if (!newName || newName === currentName) return;
        if (Object.prototype.hasOwnProperty.call(this.plugin.settings.collectionPaths, newName)) {
          (e.target as HTMLInputElement).value = currentName;
          new Notice("이미 존재하는 컬렉션 이름입니다.");
          return;
        }

        const val = this.plugin.settings.collectionPaths[currentName];
        delete this.plugin.settings.collectionPaths[currentName];
        this.plugin.settings.collectionPaths[newName] = val;
        currentName = newName;
        await this.plugin.saveSettings();
      });

      const pathCell = row.createEl("td");
      const pathInput = pathCell.createEl("input", {
        type: "text",
        value: initialPath,
        attr: { style: "width:100%; font-size:12px;" },
      });
      pathInput.addEventListener("change", async (e) => {
        const nextPath = (e.target as HTMLInputElement).value.trim();
        if (this.plugin.settings.collectionPaths[currentName] === nextPath) return;
        this.plugin.settings.collectionPaths[currentName] = nextPath;
        await this.plugin.saveSettings();
      });

      const actionCell = row.createEl("td");
      actionCell.createEl("button", { text: "삭제" }).addEventListener("click", async () => {
        delete this.plugin.settings.collectionPaths[currentName];
        await this.plugin.saveSettings();
        row.remove();
      });
    };

    const paths = this.plugin.settings.collectionPaths;
    for (const [name, colPath] of Object.entries(paths)) {
      createRow(name, colPath);
    }

    // 새 항목 추가
    const addSetting = new Setting(containerEl);
    addSetting.setName("새 컬렉션 추가").addButton((btn) =>
      btn.setButtonText("+ 추가").onClick(async () => {
        const baseName = "새컬렉션";
        let name = baseName;
        let suffix = 2;
        while (Object.prototype.hasOwnProperty.call(this.plugin.settings.collectionPaths, name)) {
          name = `${baseName}${suffix}`;
          suffix += 1;
        }
        const path = "/path/to/vault";
        this.plugin.settings.collectionPaths[name] = path;
        await this.plugin.saveSettings();
        createRow(name, path);
      })
    );
  }
}
