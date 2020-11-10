import * as childProcess from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";

import {
  headingsAndContent,
  HeadingContent,
} from "@electron/docs-parser/dist/markdown-helpers";
import MarkdownIt from "markdown-it";
import MarkdownToken from "markdown-it/lib/token";
import { v4 as uuidv4 } from "uuid";

import { buildToolsExecutable } from "./constants";
import { ElectronPatchesConfig, EVMConfig } from "./types";

const exec = promisify(childProcess.exec);
const fsReadFile = promisify(fs.readFile);
const patchedFilenameRegex = /^\+\+\+ b\/(.*)$/gm;

export type DocLink = {
  description: string;
  destination: vscode.Uri;
  level: number;
};

export type DocSection = {
  heading: string;
  level: number;
  parent?: DocSection;
  sections: DocSection[];
  links: DocLink[];
};

export enum TestRunner {
  MAIN = "main",
  REMOTE = "remote",
}

export async function isBuildToolsInstalled() {
  return new Promise((resolve, reject) => {
    const cp = childProcess.spawn(
      os.platform() === "win32" ? "where" : "which",
      [buildToolsExecutable]
    );
    cp.on("error", reject);
    cp.on("close", (exitCode) => resolve(exitCode === 0));
  });
}

export function generateSocketName() {
  return os.platform() === "win32"
    ? `\\\\.\\pipe\\${uuidv4()}`
    : path.join(os.tmpdir(), `socket-${uuidv4()}`);
}

export async function getConfigs() {
  const configs: string[] = [];
  let activeConfig: string | null = null;

  const { stdout } = await exec(`${buildToolsExecutable} show configs`, {
    encoding: "utf8",
  });
  const configsOutput = stdout.trim();

  for (const rawConfig of configsOutput.split("\n")) {
    const config = rawConfig.replace("*", "").trim();
    configs.push(config);

    if (rawConfig.trim().startsWith("*")) {
      activeConfig = config;
    }
  }

  return { configs, activeConfig };
}

export function getConfigsFilePath() {
  return path.join(os.homedir(), ".electron_build_tools", "configs");
}

export async function getConfigDefaultTarget(): Promise<string | undefined> {
  const { stdout } = await exec(
    `${buildToolsExecutable} show current --filename --no-name`,
    {
      encoding: "utf8",
    }
  );
  const configFilename = stdout.trim();

  const config: EVMConfig = JSON.parse(
    await fsReadFile(configFilename, { encoding: "utf8" })
  );

  return config.defaultTarget;
}

export function getPatchesConfigFile(electronRoot: vscode.Uri) {
  return vscode.Uri.joinPath(electronRoot, "patches", "config.json");
}

export async function getPatches(directory: vscode.Uri): Promise<vscode.Uri[]> {
  const patchListFile = vscode.Uri.joinPath(directory, ".patches");
  const patchFilenames = (await vscode.workspace.fs.readFile(patchListFile))
    .toString()
    .trim()
    .split("\n");

  return patchFilenames.map((patchFilename) =>
    vscode.Uri.joinPath(directory, patchFilename.trim())
  );
}

export async function getFilesInPatch(
  baseDirectory: vscode.Uri,
  patch: vscode.Uri
): Promise<vscode.Uri[]> {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();
  const filenames = Array.from(
    patchContents.matchAll(patchedFilenameRegex)
  ).map((match) => match[1]);

  return filenames.map((filename) =>
    vscode.Uri.joinPath(baseDirectory, filename)
  );
}

export async function parsePatchConfig(
  config: vscode.Uri
): Promise<ElectronPatchesConfig> {
  return JSON.parse((await vscode.workspace.fs.readFile(config)).toString());
}

export function getCheckoutDirectoryForPatchDirectory(
  rootDirectory: vscode.Uri,
  config: ElectronPatchesConfig,
  patchDirectory: vscode.Uri
) {
  for (const [patchDirectoryTail, checkoutDirectory] of Object.entries(
    config
  )) {
    if (patchDirectory.path.endsWith(patchDirectoryTail)) {
      return vscode.Uri.joinPath(rootDirectory, checkoutDirectory);
    }
  }

  throw new Error("Couldn't resolve patch directory");
}

export async function getPatchSubjectLine(patch: vscode.Uri) {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();

  return /^Subject: (.*)$/m.exec(patchContents)![1];
}

export async function getPatchDescription(patch: vscode.Uri) {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();

  return /Subject.*\s+([\s\S]*?)\s+diff/.exec(patchContents)![1];
}

export function truncateToLength(text: string, length: number) {
  return text.length > length ? `${text.substr(0, length - 3)}...` : text;
}

export function parsePatchMetadata(patchContents: string) {
  return {
    from: /^From: ((.*)<(\S*)>)$/m.exec(patchContents)![1],
    date: /^Date: (.*)$/m.exec(patchContents)![1],
    subject: /^Subject: (.*)$/m.exec(patchContents)![1],
    description: /Subject.*\s+([\s\S]*?)\s+diff/.exec(patchContents)![1],
    filenames: Array.from(patchContents.matchAll(patchedFilenameRegex)).map(
      (match) => match[1]
    ),
  };
}

export async function patchTooltipMarkdown(patch: vscode.Uri) {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();
  const patchMetadata = parsePatchMetadata(patchContents);

  let tooltip = "";

  const date = new Date(patchMetadata.date);
  tooltip += `${patchMetadata.from} on ${date.toLocaleString("default", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}  \n`;
  tooltip += `${patchMetadata.subject} \n`;
  tooltip += truncateToLength(patchMetadata.description, 100);

  return tooltip;
}

export async function patchOverviewMarkdown(patch: vscode.Uri) {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();
  const patchMetadata = parsePatchMetadata(patchContents);

  const markdown = new vscode.MarkdownString(undefined, true);

  const date = new Date(patchMetadata.date);
  markdown.appendMarkdown("# Patch Overview\n\n");
  markdown.appendMarkdown(
    `${patchMetadata.from} on ${date.toLocaleString("default", {
      day: "numeric",
      month: "short",
      year: "numeric",
    })}\n\n`
  );
  markdown.appendMarkdown(`## ${patchMetadata.subject}\n\n`);
  markdown.appendMarkdown(`${patchMetadata.description}\n\n`);
  markdown.appendMarkdown(`## Patch Filename\n\n`);
  markdown.appendMarkdown(`\`${path.basename(patch.fsPath)}\`\n\n`);
  markdown.appendMarkdown(`## Files\n\n`);

  for (const filename of patchMetadata.filenames) {
    markdown.appendMarkdown(`* ${filename}\n`);
  }

  return markdown;
}

export async function findCommitForPatch(
  checkoutDirectory: vscode.Uri,
  patch: vscode.Uri
) {
  const patchContents = (await vscode.workspace.fs.readFile(patch)).toString();
  const patchMetadata = parsePatchMetadata(patchContents);
  const patchName = path.basename(patch.path);

  // A local patch that hasn't been re-applied won't have the Patch-Filename
  // line, so include other details to try to ensure we get a single commit
  const gitCommand = [
    "git log refs/patches/upstream-head..HEAD",
    `--author "${patchMetadata.from}"`,
    `--since "${patchMetadata.date}"`,
    `--grep "Patch-Filename: ${patchName}"`,
    `--grep "${patchMetadata.subject}"`,
    `--pretty=format:"%h"`,
  ];

  const { stdout } = await exec(gitCommand.join(" "), {
    encoding: "utf8",
    cwd: checkoutDirectory.fsPath,
  });
  const result = stdout.trim();

  if (!result || result.split("\n").length !== 1) {
    throw new Error("Couldn't find commit");
  }

  return result;
}

export async function parseDocsSections(electronRoot: vscode.Uri) {
  const docsRoot = vscode.Uri.joinPath(electronRoot, "docs");
  const readmeContent = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(docsRoot, "README.md")
  );

  const md = new MarkdownIt();
  const parsedHeadings = headingsAndContent(
    md.parse(readmeContent.toString(), {}) as any
  );
  const rootHeading = parsedHeadings[0];

  const parseLinks = (content: MarkdownToken[]) => {
    const links = [];

    for (const { children, level, type } of content) {
      if (type === "inline" && children) {
        let href: string | undefined;

        for (const child of children) {
          if (child.type === "link_open") {
            href = child.attrs![0][1];
          } else if (href && child.type === "text") {
            // Mixed separators will mess with things, so make sure it's
            // POSIX since that's what links in the docs will be using
            const filePath = ensurePosixSeparators(
              path.resolve(docsRoot.fsPath, href)
            );

            // These links have fragments in them, so don't
            // use vscode.Uri.file to parse them
            links.push({
              description: child.content,
              destination: vscode.Uri.parse(`file:///${filePath}`),
              level,
            });
          }
        }
      } else if (type === "heading_open") {
        break; // Don't bleed into other sections
      }
    }

    return links;
  };

  const rootSection: DocSection = {
    heading: rootHeading.heading,
    level: rootHeading.level,
    sections: [],
    links: [],
  };

  const walkSections = (
    parent: DocSection | undefined,
    headings: HeadingContent[]
  ) => {
    if (headings.length === 0) {
      return;
    }

    const [{ heading, level, content }, ...remainingHeadings] = headings;

    while (parent && level <= parent.level) {
      parent = parent.parent;
    }

    if (parent) {
      parent.sections.push({
        heading,
        level,
        parent,
        sections: [],
        links: parseLinks(content as any),
      });
    } else {
      throw new Error("Malformed document layout");
    }

    walkSections(parent.sections.slice(-1)[0], remainingHeadings);
  };

  walkSections(rootSection, parsedHeadings.slice(1));

  return rootSection;
}

export async function getElectronTests(
  context: vscode.ExtensionContext,
  electronRoot: vscode.Uri,
  runner: TestRunner
) {
  let debug = false; // Toggle this in debugger to debug child process
  const debuggerOption = debug ? "--inspect-brk" : "";

  const findFilesResult = await vscode.workspace.findFiles(
    new vscode.RelativePattern(
      electronRoot.fsPath,
      `spec${runner === TestRunner.MAIN ? "-main" : ""}/**/*-spec.{js,ts}`
    )
  );

  // VS Code doesn't support negation in blobs and they don't seem to
  // want to according to issues about it, so we have to filter out
  // node_modules ourselves here or end up with files we don't want
  const testFiles = findFilesResult.filter(
    (filename) => !filename.path.includes("node_modules")
  );

  const electronExe = await vscode.commands.executeCommand<string>(
    "electron-build-tools.show.exe"
  )!;
  const scriptName = context.asAbsolutePath("out/electron/listMochaTests.js");
  const socketName = generateSocketName();

  return new Promise((resolve, reject) => {
    let result = "";

    const socketServer = net.createServer().listen(socketName);
    socketServer.on("connection", (socket) => {
      socket.on("data", (data) => {
        result += data.toString();
      });

      socket.on("error", reject);

      // Send filenames of the tests
      for (const uri of testFiles) {
        socket.write(`${uri.fsPath}\n`);
      }
      socket.write("DONE\n");
    });
    socketServer.on("error", reject);

    const cp = childProcess.exec(
      `${electronExe} ${debuggerOption} ${scriptName} ${socketName}`,
      {
        encoding: "utf8",
        cwd: electronRoot.fsPath,
        env: {
          // *DO NOT* inherit process.env, it includes stuff vscode has set like ELECTRON_RUN_AS_NODE
          TS_NODE_PROJECT: vscode.Uri.joinPath(
            electronRoot,
            "tsconfig.spec.json"
          ).fsPath,
          TS_NODE_FILES: "true", // Without this compilation fails
          TS_NODE_TRANSPILE_ONLY: "true", // Faster
          TS_NODE_COMPILER: "typescript-cached-transpile",
          ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        },
      }
    );

    cp.on("error", reject);
    cp.on("exit", (exitCode) => {
      if (exitCode !== 0) {
        reject("Non-zero exit code");
      } else {
        try {
          resolve(JSON.parse(result));
        } catch (err) {
          reject(err);
        }
      }
    });
  });
}

export function alphabetizeByLabel(treeItems: vscode.TreeItem[]) {
  return treeItems.sort((a, b) => {
    if (a.label!.toLowerCase() < b.label!.toLowerCase()) {
      return -1;
    }
    if (a.label!.toLowerCase() > b.label!.toLowerCase()) {
      return 1;
    }
    return 0;
  });
}

export function escapeStringForRegex(str: string) {
  return str.replace("(", "\\(").replace(")", "\\)").replace(".", "\\.");
}

let globalBusy = false;

// This is an unfortunate work-around to the `enablement` key for
// commands in vscode being buggy, so it can't be relied on.
export function registerCommandNoBusy(
  command: string,
  busyGuard: () => any,
  callback: (...args: any[]) => any,
  thisArg?: any
): vscode.Disposable {
  return vscode.commands.registerCommand(
    command,
    (...args: any[]): any => {
      return globalBusy ? busyGuard() : callback(...args);
    },
    thisArg
  );
}

export async function withBusyState(workFn: Function) {
  await vscode.commands.executeCommand(
    "setContext",
    "electron-build-tools:busy",
    true
  );
  globalBusy = true;

  try {
    return await workFn();
  } finally {
    vscode.commands.executeCommand(
      "setContext",
      "electron-build-tools:busy",
      false
    );
    globalBusy = false;
  }
}

export function ensurePosixSeparators(filePath: string) {
  return filePath.split(path.sep).join(path.posix.sep);
}

export const slugifyHeading = (heading: string): string => {
  return heading
    .replace(/[^A-Za-z0-9 \-]/g, "")
    .replace(/ /g, "-")
    .toLowerCase();
};
