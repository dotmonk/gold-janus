import {
  Node,
  Project,
  SyntaxKind,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  type ParameterDeclaration,
  type SourceFile,
  type TypeAliasDeclaration,
} from "ts-morph";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { schemaFromType, UnsupportedTypeError, type Schema } from "./validation";

export interface ParamInfo {
  name: string;
  typeText: string;
  isOptional: boolean;
  kind: "body" | "file";
  isFileList: boolean;
  schema: Schema | null;
}

export interface RouteInfo {
  methodName: string;
  namespaceName: string;
  paramInfos: ParamInfo[];
  returnTypeText: string;
  isSSE: boolean;
  sseEventType: string | null;
  dispatchKey: string;
}

export type RequestHandlerFn = (...args: unknown[]) => Promise<unknown> | unknown;
export type StreamHandlerFn = (...args: unknown[]) => AsyncGenerator<unknown>;

export interface DispatchEntry<H> {
  route: RouteInfo;
  handler: H;
}

interface ApiModule {
  filePath: string;
  namespaceName: string;
}

function filePathToNamespace(filePath: string): string {
  const name = path.basename(filePath, ".ts").replace(/^Api|Api$/g, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function unwrapPromise(t: string): string {
  return t.replace(/^Promise<([\s\S]+)>$/, "$1");
}

function extractSSEEventType(t: string): string | null {
  const m = t.match(/^Async(?:Generator|Iterable(?:Iterator)?)<([\s\S]+)>/);
  if (!m) return null;
  let depth = 0;
  for (let i = 0; i < m[1].length; i++) {
    if (m[1][i] === "<") depth++;
    else if (m[1][i] === ">") depth--;
    else if (m[1][i] === "," && depth === 0) return m[1].slice(0, i).trim();
  }
  return m[1].trim() || null;
}

function inferParamKind(typeText: string): ParamInfo["kind"] {
  return /\bUploadedFile\b/.test(typeText) ? "file" : "body";
}

function collectApiModules(backendDir: string): ApiModule[] {
  const filePaths = (fs.readdirSync(backendDir, { recursive: true }) as string[])
    .filter((f): f is string => typeof f === "string" && f.endsWith("Api.ts"))
    .map((f) => path.join(backendDir, f))
    .sort();

  const byNamespace = new Map<string, string[]>();
  const problems: string[] = [];
  for (const filePath of filePaths) {
    const namespaceName = filePathToNamespace(filePath);
    if (!/^[A-Za-z_$][\w$]*$/.test(namespaceName)) {
      problems.push(`${displayPath(filePath)} gives namespace "${namespaceName}", which is not a valid identifier`);
      continue;
    }
    byNamespace.set(namespaceName, [...(byNamespace.get(namespaceName) ?? []), filePath]);
  }
  for (const [namespaceName, files] of byNamespace) {
    if (files.length > 1) {
      problems.push(`namespace "${namespaceName}" comes from more than one file: ${files.map(displayPath).join(", ")}`);
    }
  }
  if (problems.length > 0) throw startupError(problems);
  return [...byNamespace].map(([namespaceName, [filePath]]) => ({ filePath, namespaceName }));
}

function displayPath(filePath: string): string {
  return path.relative(process.cwd(), filePath) || filePath;
}

function startupError(problems: string[]): Error {
  return new Error(`Gild: cannot start:\n  - ${problems.join("\n  - ")}`);
}

type EmittableDeclaration = InterfaceDeclaration | TypeAliasDeclaration;

/** Collects the type declarations the client `.d.ts` needs, following imports. */
class ClientTypeCollector {
  private readonly byName = new Map<string, EmittableDeclaration>();
  private readonly conflicts = new Map<string, Set<string>>();
  private readonly problems: string[];

  constructor(problems: string[]) {
    this.problems = problems;
  }

  addDeclaration(declaration: EmittableDeclaration): void {
    const name = declaration.getName();
    const existing = this.byName.get(name);
    if (existing === declaration) return;
    if (existing) {
      if (existing.getText() !== declaration.getText()) {
        const files = this.conflicts.get(name) ?? new Set([displayPath(existing.getSourceFile().getFilePath())]);
        files.add(displayPath(declaration.getSourceFile().getFilePath()));
        this.conflicts.set(name, files);
      }
      return;
    }
    this.byName.set(name, declaration);
    this.addReferencesIn(declaration);
  }

  addReferencesIn(node: Node): void {
    const referenceNames = [
      ...(Node.isTypeReference(node) ? [node] : []),
      ...node.getDescendantsOfKind(SyntaxKind.TypeReference),
    ].map((reference) => reference.getTypeName());
    const heritageNames = node
      .getDescendantsOfKind(SyntaxKind.ExpressionWithTypeArguments)
      .map((heritage) => heritage.getExpression());

    for (const nameNode of [...referenceNames, ...heritageNames]) {
      let symbol = nameNode.getSymbol();
      if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol() ?? symbol;
      for (const declaration of symbol?.getDeclarations() ?? []) {
        const sourceFile = declaration.getSourceFile();
        if (isExternalSource(sourceFile)) continue;
        if (Node.isInterfaceDeclaration(declaration) || Node.isTypeAliasDeclaration(declaration)) {
          this.addDeclaration(declaration);
        } else if (Node.isEnumDeclaration(declaration) || Node.isClassDeclaration(declaration)) {
          this.problems.push(
            `type "${declaration.getName()}" in ${displayPath(sourceFile.getFilePath())} is a ` +
              `${declaration.getKindName()}; only interfaces and type aliases can be shared with the client`
          );
        }
      }
    }
  }

  declarationTexts(): string[] {
    for (const [name, files] of this.conflicts) {
      this.problems.push(`conflicting declarations for type "${name}": ${[...files].join(", ")}`);
    }
    return [...this.byName.values()].map((declaration) =>
      `export ${declaration.getText().replace(/^export\s+(default\s+)?/, "")}\n`
    );
  }
}

function isExternalSource(sourceFile: SourceFile): boolean {
  return (
    sourceFile.isInNodeModules() ||
    sourceFile.isDeclarationFile() ||
    path.dirname(path.resolve(sourceFile.getFilePath())) === __dirname
  );
}

async function importApiModule(filePath: string): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`Gild: cannot start: importing ${displayPath(filePath)} failed: ${reason}`), {
      cause: error,
    });
  }
}

function describeParameters(
  route: Pick<RouteInfo, "dispatchKey" | "isSSE">,
  parameters: ParameterDeclaration[],
  types: ClientTypeCollector,
  problems: string[]
): ParamInfo[] {
  return parameters.map((p) => {
    const typeNode = p.getTypeNode();
    const typeText = typeNode?.getText() ?? p.getType().getText(p).replace(/\s*\|\s*undefined$/, "");
    const kind = inferParamKind(typeText);
    if (typeNode) types.addReferencesIn(typeNode);

    let schema: Schema | null = null;
    if (kind === "file" && route.isSSE) {
      problems.push(`${route.dispatchKey}: streams cannot take uploads (parameter "${p.getName()}")`);
    } else if (kind === "body") {
      try {
        schema = schemaFromType(p.getType(), p);
      } catch (error: unknown) {
        if (!(error instanceof UnsupportedTypeError)) throw error;
        problems.push(
          `${route.dispatchKey}: parameter "${p.getName()}" has type ${typeText}, which cannot be checked at ` +
            `runtime (${error.message}); use JSON data types`
        );
      }
    }
    return {
      name: p.getName(),
      typeText,
      isOptional: p.isOptional(),
      kind,
      isFileList: kind === "file" && /\[\]$|^(ReadonlyArray|Array)</.test(typeText),
      schema,
    };
  });
}

const WRAPPERS_OF_SENT_VALUE = new Set(["Promise", "AsyncGenerator", "AsyncIterable", "AsyncIterableIterator"]);

/** The value that reaches the client is JSON, so its type must be JSON data, like parameters. */
function checkSentType(fn: FunctionDeclaration, route: Pick<RouteInfo, "dispatchKey" | "returnTypeText">, problems: string[]): void {
  let sentType = fn.getReturnType();
  const wrapper = sentType.getSymbol()?.getName();
  if (wrapper && WRAPPERS_OF_SENT_VALUE.has(wrapper)) sentType = sentType.getTypeArguments()[0] ?? sentType;
  try {
    schemaFromType(sentType, fn);
  } catch (error: unknown) {
    if (!(error instanceof UnsupportedTypeError)) throw error;
    problems.push(
      `${route.dispatchKey}: sends ${route.returnTypeText}, which arrives differently after JSON ` +
        `(${error.message}); return JSON data types`
    );
  }
}

export interface DiscoveredApi {
  backendDir: string;
  routes: RouteInfo[];
  requestDispatch: Map<string, DispatchEntry<RequestHandlerFn>>;
  sseDispatch: Map<string, DispatchEntry<StreamHandlerFn>>;
  typeDeclarations: string[];
}

/** Finds every `*Api.ts` under `backend/`, imports it and describes its exported functions; throws on any problem. */
export async function discoverApi(): Promise<DiscoveredApi> {
  const backendDir = path.resolve(process.cwd(), "backend");
  const apiModules = collectApiModules(backendDir);

  const project = new Project({
    tsConfigFilePath: path.resolve(process.cwd(), "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  apiModules.forEach((m) => project.addSourceFileAtPath(m.filePath));

  const routes: RouteInfo[] = [];
  const problems: string[] = [];
  const types = new ClientTypeCollector(problems);
  const requestDispatch = new Map<string, DispatchEntry<RequestHandlerFn>>();
  const sseDispatch = new Map<string, DispatchEntry<StreamHandlerFn>>();

  for (const { filePath, namespaceName } of apiModules) {
    const sourceFile = project.getSourceFileOrThrow(filePath);
    for (const declaration of [...sourceFile.getInterfaces(), ...sourceFile.getTypeAliases()]) {
      types.addDeclaration(declaration);
    }

    const exports = await importApiModule(filePath);

    for (const fn of sourceFile.getFunctions()) {
      if (!fn.isExported()) continue;
      const methodName = fn.getName();
      if (!methodName) continue;
      const handler = exports[methodName];
      if (typeof handler !== "function") continue;

      const returnTypeNode = fn.getReturnTypeNode();
      if (returnTypeNode) types.addReferencesIn(returnTypeNode);
      const rawReturn = returnTypeNode?.getText() ?? fn.getReturnType().getText(fn);
      const isSSE = fn.isGenerator() || /(^|\W)Async(?:Generator|Iterable(?:Iterator)?)(<|\W|$)/.test(rawReturn);
      const sseEventType = isSSE ? extractSSEEventType(rawReturn) : null;
      const returnTypeText = isSSE ? (sseEventType ?? "unknown") : unwrapPromise(rawReturn);
      const dispatchKey = `${namespaceName}.${methodName}`;
      const paramInfos = describeParameters({ dispatchKey, isSSE }, fn.getParameters(), types, problems);

      const route: RouteInfo = { methodName, namespaceName, paramInfos, returnTypeText, isSSE, sseEventType, dispatchKey };
      checkSentType(fn, route, problems);
      routes.push(route);
      if (isSSE) sseDispatch.set(dispatchKey, { route, handler: handler as StreamHandlerFn });
      else requestDispatch.set(dispatchKey, { route, handler: handler as RequestHandlerFn });
    }
  }

  const typeDeclarations = types.declarationTexts();
  if (problems.length > 0) throw startupError(problems);
  return { backendDir, routes, requestDispatch, sseDispatch, typeDeclarations };
}
