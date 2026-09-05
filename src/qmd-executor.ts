import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * QMD CLI 호출과 결과 정규화를 담당한다.
 *
 * 흐름 개요:
 * settings/main -> QmdExecutor 생성 및 갱신
 *   -> 명령 실행(runCommand / runStreamingCommand)
 *     -> stdout/stderr 정리
 *       -> JSON 결과 파싱 / 경로 해석 / 상태 문자열 반환
 *         -> search view / modal / settings UI가 소비
 *
 * 핵심 보장:
 * - 실행 환경 변수는 모든 호출에서 동일한 규칙으로 조립한다.
 * - qmd URI는 collection + vault 상대 경로로 정규화해 후속 UI가 재사용한다.
 * - 오류 메시지는 사용자에게 보여줄 수 있는 짧은 형태로 축약한다.
 */
function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/** 퍼센트 인코딩이 깨진 경로도 그대로 통과시켜 검색 결과 렌더링을 막지 않도록 한다. */
function safeDecodeURIComponent(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}


// 실제 qmd --json 출력 구조
export interface QmdResult {
  docid: string;
  score: number;
  file: string;      // "qmd://obsidian/path/to/file.md"
  title?: string;
  context?: string;
  snippet?: string;
  // 편의용 (파싱 후 채움)
  collection: string;
  relativePath: string;
}

export interface CollectionPathMap {
  [collection: string]: string;
}

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";

export class QmdExecutor {
  private qmdPath: string;
  private collectionPaths: CollectionPathMap;
  private forceCpu: boolean;
  private dryRun: boolean;
  private logLevel: LogLevel;

  constructor(
    qmdPath: string,
    collectionPaths: CollectionPathMap = {},
    forceCpu = false,
    dryRun = false,
    logLevel: LogLevel = "WARN"
  ) {
    this.qmdPath = qmdPath;
    this.collectionPaths = collectionPaths;
    this.forceCpu = forceCpu;
    this.dryRun = dryRun;
    this.logLevel = logLevel;
  }

  updateSettings(
    qmdPath: string,
    collectionPaths: CollectionPathMap,
    forceCpu: boolean,
    dryRun: boolean,
    logLevel: LogLevel
  ) {
    this.qmdPath = qmdPath;
    this.collectionPaths = collectionPaths;
    this.forceCpu = forceCpu;
    this.dryRun = dryRun;
    this.logLevel = logLevel;
  }

  /**
   * qmd subprocess에 주입할 실행 환경을 구성한다.
   * - PATH는 데스크톱 환경에서 흔한 설치 위치를 앞쪽에 둔다.
   * - dry-run / forceCpu는 실제 실행 시와 동일한 조건에서만 추가한다.
   */
  private getEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [
        path.join(os.homedir(), ".asdf", "shims"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        process.env.PATH || "",
      ].join(":"),
      NO_COLOR: "1",
    };

    if (this.forceCpu) {
      env.QMD_FORCE_CPU = "1";
    }
    env.QMD_LOG_LEVEL = this.logLevel.toLowerCase();
    if (this.dryRun) {
      env.QMD_DRY_RUN = "1";
    }

    return env;
  }

  /** 플러그인/실행기 양쪽에서 동일한 로그 레벨 우선순위를 사용한다. */
  private shouldLog(level: LogLevel): boolean {
    const order: Record<LogLevel, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
    return order[level] <= order[this.logLevel];
  }

  private log(level: LogLevel, ...args: unknown[]) {
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
   * 단발성 qmd 명령을 실행한다.
   * 성공 시 stdout 전체를 반환하고, 실패 시에는 스택 트레이스를 벗겨낸 메시지만 노출한다.
   */
  async runCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.qmdPath, args, {
        env: this.getEnv(),
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code: number) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          // stderr에서 핵심 오류 메시지만 추출 (스택 트레이스 제거)
          const cleanError = this.extractCleanError(stderr || stdout);
          reject(new Error(cleanError));
        }
      });

      proc.on("error", (err: Error) => {
        reject(
          new Error(`qmd 실행 실패: ${err.message}. 경로: ${this.qmdPath}`)
        );
      });
    });
  }

  /**
   * update/embed처럼 긴 작업의 출력을 줄 단위로 스트리밍한다.
   * stdout/stderr를 동일 버퍼로 합쳐 진행 상황을 순서대로 보여주되, 마지막 미완성 줄도 close 시점에 보존한다.
   */
  runStreamingCommand(
    args: string[],
    onLine: (line: string) => void,
    onError: (err: Error) => void,
    onDone: (code: number) => void
  ): void {
    const proc = spawn(this.qmdPath, args, {
      env: this.getEnv(),
    });

    let buffer = "";

    const processBuffer = (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line) onLine(line);
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      processBuffer(data.toString());
    });

    proc.stderr.on("data", (data: Buffer) => {
      processBuffer(data.toString());
    });

    proc.on("close", (code: number) => {
      if (buffer.trim()) onLine(buffer.trim());
      onDone(code ?? 0);
    });

    proc.on("error", (err: Error) => {
      onError(err);
    });
  }

  async search(
    query: string,
    collection?: string,
    limit: number = 10
  ): Promise<QmdResult[]> {
    // qmd search <query> --json -n <limit> [-c <collection>]
    const args = ["search", query, "--json", "-n", String(limit)];
    if (collection) args.push("-c", collection);

    const output = await this.runCommand(args);
    return this.parseJsonResults(output);
  }

  async vsearch(
    query: string,
    collection?: string,
    limit: number = 10
  ): Promise<QmdResult[]> {
    // qmd vsearch <query> --json -n <limit> [-c <collection>]
    const args = ["vsearch", query, "--json", "-n", String(limit)];
    if (collection) args.push("-c", collection);

    const output = await this.runCommand(args);
    return this.parseJsonResults(output);
  }

  /**
   * qmd가 stderr/stdout에 섞어 쓰는 원시 오류에서 사용자 행동으로 이어질 핵심 메시지만 추린다.
   * Deep 검색 컨텍스트 초과는 자주 발생하는 예외라서 별도 안내문으로 치환한다.
   */
  /** stderr / stdout 에서 스택 트레이스를 제거하고 핵심 오류 메시지만 반환 */
  private extractCleanError(raw: string): string {
    if (!raw) return "알 수 없는 오류";

    // 컨텍스트 크기 초과 오류 (node-llama-cpp 리랭킹 실패)
    if (raw.includes("exceed the context size")) {
      return (
        "Deep 검색 실패: 문서가 너무 길어 리랭킹 모델의 컨텍스트 크기를 초과했습니다.\n" +
        "💡 특정 컬렉션을 선택한 후 다시 시도하거나, BM25 또는 Vector 검색을 사용하세요."
      );
    }

    // Error: ... 패턴에서 첫 번째 메시지만 추출
    const errorMatch = raw.match(/Error:\s*(.+)/);
    if (errorMatch) return errorMatch[1].trim();

    // 마지막 비어 있지 않은 줄 반환 (진행 로그 제거)
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    return lines[lines.length - 1] || raw.substring(0, 200);
  }

  async deepQuery(
    query: string,
    collection?: string,
    limit: number = 10
  ): Promise<QmdResult[]> {
    // qmd query <query> --json -n <limit> [-c <collection>]
    const args = ["query", query, "--json", "-n", String(limit)];
    if (collection) args.push("-c", collection);

    const output = await this.runCommand(args);
    return this.parseJsonResults(output);
  }

  /**
   * qmd 출력에서 JSON 배열 부분만 골라 검색 결과로 정규화한다.
   * 진행 로그가 함께 섞여도 최대한 복구하고, 파싱 실패 시에는 예외를 다시 던지지 않고 빈 결과로 안전하게 처리한다.
   */
  private parseJsonResults(output: string): QmdResult[] {
    try {
      // stdout에서 JSON 배열 부분만 추출 (vsearch는 진행 상황을 stderr로 내보내지만 혼용될 수 있음)
      const jsonMatch = output.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const raw: Array<{
        docid: string;
        score: number;
        file: string;
        title?: string;
        context?: string;
        snippet?: string;
      }> = JSON.parse(jsonMatch[0]);

      return raw.map((item) => {
        const parsed = this.parseQmdUri(item.file);
        return {
          ...item,
          collection: parsed?.collection || "",
          relativePath: parsed?.relativePath || item.file,
        };
      });
    } catch (e) {
      console.error("QMD 결과 파싱 실패:", e, "출력:", output);
      return [];
    }
  }

  async status(): Promise<string> {
    return this.runCommand(["status"]);
  }

  async listCollections(): Promise<string> {
    return this.runCommand(["collection", "list"]);
  }

  /**
   * qmd://collection/path URI를 UI 친화적인 구조로 변환한다.
   * 경로는 퍼센트 디코딩과 슬래시 정규화를 거치며, collection/path 중 하나라도 비어 있으면 무효로 본다.
   */
  parseQmdUri(uri: string): { collection: string; relativePath: string } | null {
    if (!uri || typeof uri !== "string") return null;

    const trimmed = uri.trim();
    const normalizedUri = trimmed.replace(/^qmd:\/*/i, "qmd://");

    const match = normalizedUri.match(/^qmd:\/\/([^/]+)\/(.+)$/);
    if (!match) return null;

    const collection = match[1]?.trim();
    const rawPath = match[2] ?? "";

    if (!collection || !rawPath) return null;

    const decoded = safeDecodeURIComponent(rawPath);
    const normalizedPath = normalizeSlashes(decoded).replace(/^\/+/, "");

    return {
      collection,
      relativePath: normalizedPath
    };
  }

  /**
   * qmd 결과 경로를 현재 Obsidian 볼트 기준 상대 경로로 변환한다.
   * 같은 볼트 내부 컬렉션만 열 수 있으므로, 컬렉션 루트가 현재 볼트 바깥이면 null을 반환해 상위 UI가 안내문을 고른다.
   */
  resolveToVaultRelativePath(result: QmdResult, vaultRoot: string): string | null {
    const collectionBase = this.collectionPaths[result.collection];
    if (!collectionBase) {
      this.log("INFO", "QMD: No collection path found for", result.collection);
      return null;
    }

    // 비교용 경로는 구분자와 마지막 슬래시만 통일한다.
    const normalize = (p: string) => p.replace(/[\\\/]+/g, "/").replace(/\/$/, "");
    
    const nvRoot = normalize(vaultRoot);
    const ncBase = normalize(collectionBase);

    this.log("DEBUG", "QMD Debug: Path Comparison", {
      vaultRoot: nvRoot,
      collectionBase: ncBase,
      resultPath: result.relativePath
    });

    // macOS/Windows 환경에서는 대소문자 차이만으로 볼트 내부 파일을 놓치지 않도록 소문자 비교를 사용한다.
    const nvRootLower = nvRoot.toLowerCase();
    const ncBaseLower = ncBase.toLowerCase();

    if (
      ncBaseLower === nvRootLower ||
      ncBaseLower.startsWith(nvRootLower + "/")
    ) {
      let vaultRelativePrefix = "";
      if (ncBaseLower !== nvRootLower) {
        // 컬렉션 루트가 볼트 하위 폴더를 가리키는 경우, 그 하위 경로를 상대 경로 prefix로 보존한다.
        vaultRelativePrefix = ncBase
          .slice(nvRoot.length)
          .replace(/^[\\\/]/, "");
      }

      const cleanRelativePath = result.relativePath.replace(/^[\\\/]/, "");
      
      const finalPath = vaultRelativePrefix
        ? `${vaultRelativePrefix}/${cleanRelativePath}`
        : cleanRelativePath;

      this.log("DEBUG", "QMD Debug: Resolved Vault Path ->", finalPath);
      return finalPath;
    }

    this.log("DEBUG", "QMD Debug: Path is outside this vault.");
    return null;
  }

  /**
   * ~/.config/qmd/index.yml의 collections 섹션에서 name -> path 매핑만 얕게 추출한다.
   * 완전한 YAML 파서는 아니므로 현재 qmd 설정 포맷을 전제로 하며, 형식이 다르면 빈 맵으로 안전하게 되돌린다.
   */
  async parseQmdConfig(): Promise<CollectionPathMap> {
    const configPath = path.join(os.homedir(), ".config", "qmd", "index.yml");
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const result: CollectionPathMap = {};

      // collections: 섹션에서 name과 path 추출
      // 패턴: 2칸 들여쓰기된 컬렉션 이름 다음에 4칸 들여쓰기된 path:
      const lines = content.split("\n");
      let inCollections = false;
      let currentCollection = "";

      for (const line of lines) {
        if (line.trim() === "collections:") {
          inCollections = true;
          continue;
        }
        if (inCollections) {
          // 2칸 들여쓰기: 컬렉션 이름
          const collMatch = line.match(/^  (\w[\w-]*):\s*$/);
          if (collMatch) {
            currentCollection = collMatch[1];
            continue;
          }
          // 4칸 들여쓰기: path 값
          const pathMatch = line.match(/^    path:\s*(.+)$/);
          if (pathMatch && currentCollection) {
            result[currentCollection] = pathMatch[1].trim().replace(/^['"]|['"]$/g, "");
            continue;
          }
          // 최상위 레벨로 돌아감
          if (line.match(/^\S/) && line.trim() !== "collections:") {
            inCollections = false;
          }
        }
      }

      return result;
    } catch (e) {
      this.log("WARN", "qmd config 읽기 실패:", e);
      return {};
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.runCommand(["status"]);
      return true;
    } catch {
      return false;
    }
  }
}