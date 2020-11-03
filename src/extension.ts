import * as vscode from "vscode";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as readline from "readline";

import { ElectronBuildToolsConfigsProvider } from "./configsView";
import {
  generateSocketName,
  getConfigs,
  getConfigsFilePath,
  killThemAll,
} from "./utils";

async function electronIsInWorkspace(workspaceFolder: vscode.WorkspaceFolder) {
  const possiblePackageRoots = [".", "electron"];
  for (const possibleRoot of possiblePackageRoots) {
    const rootPackageFilename = path.join(
      workspaceFolder.uri.fsPath,
      possibleRoot,
      "package.json"
    );
    if (!fs.existsSync(rootPackageFilename)) {
      continue;
    }

    const rootPackageFile = await vscode.workspace.fs.readFile(
      vscode.Uri.file(rootPackageFilename)
    );

    const { name } = JSON.parse(rootPackageFile.toString());

    return name === "electron";
  }
}

function registerElectronBuildToolsCommands(
  context: vscode.ExtensionContext,
  configsProvider: ElectronBuildToolsConfigsProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("electron-build-tools.build", () => {
      const command = "electron-build-tools build";
      const operationName = "Electron Build Tools - Building";

      const socketName = generateSocketName();

      const buildEnv = {
        ...process.env,
        NINJA_STATUS: "%p %f/%t ",
      };

      const task = new vscode.Task(
        { type: "electron-build-tools", task: "build" },
        vscode.workspace.workspaceFolders![0],
        "build",
        "electron-build-tools",
        new vscode.ShellExecution(
          `${command} | node tee-to-socket.js ${socketName}`,
          { cwd: __dirname, env: buildEnv }
        ),
        "$electron"
      );

      // TODO - How to stop the terminal from being closed on task cancel?
      task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Silent,
        echo: false,
        clear: true,
      };

      const socketServer = net.createServer().listen(socketName);

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: operationName.split("-")[1].trim(),
          cancellable: true,
        },
        async (progress, token) => {
          let lastBuildProgress = 0;

          socketServer.on("connection", (socket) => {
            const rl = readline.createInterface({
              input: socket,
            });

            rl.on("line", (line) => {
              if (/Regenerating ninja files/.test(line)) {
                progress.report({
                  message: "Regenerating Ninja Files",
                  increment: 0,
                });
              } else {
                const buildProgress = parseInt(line.split("%")[0].trim());

                if (!isNaN(buildProgress)) {
                  if (buildProgress > lastBuildProgress) {
                    progress.report({
                      message: "Compiling",
                      increment: buildProgress - lastBuildProgress,
                    });
                    lastBuildProgress = buildProgress;
                  }
                } else {
                  if (/Running.*goma/.test(line)) {
                    progress.report({ message: "Starting Goma" });
                  } else if (/Running.*ninja/.test(line)) {
                    progress.report({ message: "Starting" });
                  }
                }
              }
            });
          });

          const taskExecution = await vscode.tasks.executeTask(task);

          return new Promise(async (resolve, reject) => {
            socketServer.on("error", () => reject("Socket server error"));

            vscode.tasks.onDidEndTask(({ execution }) => {
              if (execution === taskExecution) {
                resolve();
              }
            });

            vscode.tasks.onDidEndTaskProcess(({ execution, exitCode }) => {
              if (execution === taskExecution && exitCode && exitCode !== 0) {
                vscode.window.showErrorMessage(
                  `'${operationName}' failed with exit code ${exitCode}`
                );
              }
            });

            token.onCancellationRequested(() => {
              resolve();
              taskExecution.terminate();
              console.warn(`User canceled '${command}'`);
            });
          }).finally(() => taskExecution.terminate());
        }
      );
    }),
    vscode.commands.registerCommand(
      "electron-build-tools.remove-config",
      (config) => {
        childProcess.exec(
          `electron-build-tools remove ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (error || stdout.trim() !== `Removed config ${config.label}`) {
              vscode.window.showErrorMessage(
                `Failed to remove config: ${stderr.trim()}`
              );
            } else {
              // TBD - This isn't very noticeable
              vscode.window.setStatusBarMessage("Removed config");
              configsProvider.refresh();
            }
          }
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.sanitize-config",
      (config) => {
        childProcess.exec(
          `electron-build-tools sanitize-config ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (
              error ||
              stdout.trim() !== `SUCCESS Sanitized contents of ${config.label}`
            ) {
              vscode.window.showErrorMessage(
                `Failed to sanitize config: ${stderr.trim()}`
              );
            } else {
              // TBD - This isn't very noticeable
              vscode.window.setStatusBarMessage("Sanitized config");
            }
          }
        );
      }
    ),
    vscode.commands.registerCommand("electron-build-tools.show.exe", () => {
      return childProcess
        .execSync("electron-build-tools show exe", { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand("electron-build-tools.show.goma", () => {
      childProcess.execSync("electron-build-tools show goma");
    }),
    vscode.commands.registerCommand("electron-build-tools.show.outdir", () => {
      return childProcess
        .execSync("electron-build-tools show outdir", { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand("electron-build-tools.show.root", () => {
      return childProcess
        .execSync("electron-build-tools show root", { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand("electron-build-tools.sync", () => {
      const command = "electron-build-tools sync";
      const operationName = "Electron Build Tools - Syncing";

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: operationName.split("-")[1].trim(),
          cancellable: true,
        },
        (progress, token) => {
          return new Promise((resolve) => {
            const syncOperation = childProcess.exec(command);
            let killed = false;

            syncOperation.on("error", (error) => {
              vscode.window.showErrorMessage(
                `'${operationName}' had an error occur: ${error.message}`
              );
              resolve();
            });

            syncOperation.on("exit", (exitCode) => {
              if (exitCode && !killed && exitCode !== 0) {
                vscode.window.showErrorMessage(
                  `'${operationName}' failed with exit code ${exitCode}`
                );
              }
              resolve();
            });

            token.onCancellationRequested(() => {
              killed = true;
              killThemAll(syncOperation);
              console.warn(`User canceled '${command}'`);
              resolve();
            });

            const rl = readline.createInterface({
              input: syncOperation.stdout!,
            });

            let initialProgress = false;

            // TODO - Add more progress updates
            rl.on("line", (line) => {
              if (/running.*apply_all_patches\.py/.test(line)) {
                progress.report({ message: "Applying Patches" });
              } else if (/Hook.*apply_all_patches\.py.*took/.test(line)) {
                progress.report({ message: "Finishing Up" });
              } else if (!initialProgress) {
                initialProgress = true;
                progress.report({ message: "Dependencies" });
              }
            });
          });
        }
      );
    }),
    vscode.commands.registerCommand(
      "electron-build-tools.useConfig",
      (config) => {
        // Do an optimistic update for snappier UI
        configsProvider.setActive(config.label);

        childProcess.exec(
          `electron-build-tools use ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout) => {
            if (error || stdout.trim() !== `Now using config ${config.label}`) {
              vscode.window.showErrorMessage(
                "Failed to set active Electron build-tools config"
              );
              configsProvider.setActive(null);
              configsProvider.refresh();
            }
          }
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.useConfigQuickPick",
      async () => {
        const { configs } = getConfigs();
        const selected = await vscode.window.showQuickPick(configs);

        if (selected) {
          // Do an optimistic update for snappier UI
          configsProvider.setActive(selected);

          childProcess.exec(
            `electron-build-tools use ${selected}`,
            {
              encoding: "utf8",
            },
            (error, stdout) => {
              if (error || stdout.trim() !== `Now using config ${selected}`) {
                vscode.window.showErrorMessage(
                  "Failed to set active Electron build-tools config"
                );
                configsProvider.setActive(null);
                configsProvider.refresh();
              }
            }
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.openConfig",
      async (configName) => {
        const configFilePath = path.join(
          getConfigsFilePath(),
          `evm.${configName}.json`
        );
        try {
          const document = await vscode.workspace.openTextDocument(
            configFilePath
          );
          await vscode.window.showTextDocument(document);
        } catch (e) {
          console.log(e);
        }

        return configFilePath;
      }
    )
  );
}

function registerHelperCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vscode.window.showOpenDialog",
      async (options) => {
        const results = await vscode.window.showOpenDialog(options);

        if (results) {
          return results[0].fsPath;
        }
      }
    )
  );
}

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (workspaceFolders) {
    if (electronIsInWorkspace(workspaceFolders[0])) {
      const configsProvider = new ElectronBuildToolsConfigsProvider();
      registerElectronBuildToolsCommands(context, configsProvider);
      registerHelperCommands(context);
      context.subscriptions.push(
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:configs",
          configsProvider
        ),
        vscode.workspace.onDidOpenTextDocument((document) => {
          if (path.basename(document.fileName) === "DEPS") {
            vscode.languages.setTextDocumentLanguage(document, "python");
          }
        })
      );
    }
  }
}
