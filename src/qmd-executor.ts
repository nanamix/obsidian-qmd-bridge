import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

export class QmdExecutor {
  private qmdPath: string;
  private collectionPaths: CollectionPathMap;

  constructor(qmdPath: string, collectionPaths: CollectionPathMap = {}) {
    this.qmdPath = qmdPath;
    this.collectionPaths = collectionPaths;
  }

  updateSettings(qmdPath: string, collectionPaths: CollectionPathMap) {
    this.qmdPath = qmdPath;
    this.collectionPaths = collectionPaths;
  }

  private getEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: [
        "/Users/jinyoungha/.asdf/shims",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/homebrew/bin",
        process.env.PATH || "",
      ].join(":"),
    };
  }

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

  parseQmdUri(uri: string): { collection: string; relativePath: string } | null {
    const match = uri.match(/^qmd:\/\/([^/]+)\/(.+)$/);
    if (!match) return null;
    try {
      return { 
        collection: match[1], 
        relativePath: decodeURIComponent(match[2]) 
      };
    } catch (e) {
      return { collection: match[1], relativePath: match[2] };
    }
  }

  resolveToVaultRelativePath(result: QmdResult, vaultRoot: string): string | null {
    const collectionBase = this.collectionPaths[result.collection];
    if (!collectionBase) {
      console.log("QMD: No collection path found for", result.collection);
      return null;
    }

    // 경로 정규화 함수
    const normalize = (p: string) => p.replace(/[\\\/]+/g, "/").replace(/\/$/, "");
    
    const nvRoot = normalize(vaultRoot);
    const ncBase = normalize(collectionBase);

    console.log("QMD Debug: Path Comparison", {
      vaultRoot: nvRoot,
      collectionBase: ncBase,
      resultPath: result.relativePath
    });

    // 대소문자 구분 없이 비교 (macOS/Windows 대응)
    const nvRootLower = nvRoot.toLowerCase();
    const ncBaseLower = ncBase.toLowerCase();

    if (
      ncBaseLower === nvRootLower ||
      ncBaseLower.startsWith(nvRootLower + "/")
    ) {
      let vaultRelativePrefix = "";
      if (ncBaseLower !== nvRootLower) {
        vaultRelativePrefix = ncBase
          .slice(nvRoot.length)
          .replace(/^[\\\/]/, "");
      }

      const cleanRelativePath = result.relativePath.replace(/^[\\\/]/, "");
      
      const finalPath = vaultRelativePrefix
        ? `${vaultRelativePrefix}/${cleanRelativePath}`
        : cleanRelativePath;

      console.log("QMD Debug: Resolved Vault Path ->", finalPath);
      return finalPath;
    }

    console.log("QMD Debug: Path is outside this vault.");
    return null;
  }

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
      console.error("qmd config 읽기 실패:", e);
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
