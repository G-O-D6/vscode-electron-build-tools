import * as childProcess from "child_process";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";

import { buildToolsExecutable, commandPrefix, viewIds } from "../constants";
import {
  default as ExtensionState,
  ExtensionOperation,
} from "../extensionState";
import Logger from "../logging";
import { getConfigsFilePath, sleep } from "../utils";
import type {
  ConfigCollector,
  ConfigTreeItem,
  ElectronBuildToolsConfigsProvider,
} from "../views/configs";

const exec = promisify(childProcess.exec);

interface ConfigOptionItem extends vscode.QuickPickItem {
  optionName?: string;
}

export function registerConfigsCommands(
  context: vscode.ExtensionContext,
  configsCollector: ConfigCollector,
  configsProvider: ElectronBuildToolsConfigsProvider
) {
  context.subscriptions.push(
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.CHANGE_CONFIG,
      `${commandPrefix}.newConfig`,
      () => {
        vscode.window.showErrorMessage(
          "Can't create new config, other work in-progress"
        );
      },
      async () => {
        try {
          const configName = await new Promise<string | undefined>(
            (resolve) => {
              const configNameInput = vscode.window.createInputBox();
              configNameInput.title = "New Electron Build Tools Config";
              configNameInput.step = 1;
              configNameInput.totalSteps = 4;
              configNameInput.prompt = "Enter config name";
              configNameInput.onDidHide(() => {
                configNameInput.dispose();
                resolve(undefined);
              });
              configNameInput.onDidAccept(() => {
                resolve(configNameInput.value);
                configNameInput.dispose();
              });
              configNameInput.show();
            }
          );

          if (configName === undefined) {
            return;
          }

          const rootPath = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
          });

          if (rootPath === undefined) {
            return;
          }

          const options = await new Promise<
            readonly ConfigOptionItem[] | undefined
          >((resolve) => {
            const configOptionsQuickPick = vscode.window.createQuickPick<ConfigOptionItem>();
            configOptionsQuickPick.title = "New Electron Build Tools Config";
            configOptionsQuickPick.placeholder = "Configuration options";
            configOptionsQuickPick.items = [
              {
                label: "Add Fork",
                detail: "Add a remote fork of Electron with the name 'fork'",
              },
              {
                label: "Use HTTPS",
                detail:
                  "During sync, set remote origins with https://github... URLs instead of git@github...",
                optionName: "use-https",
              },
              {
                label: "Address Sanitizer",
                detail: "When building, enable clang's address sanitizer",
                optionName: "asan",
              },
              {
                label: "Leak Sanitizer",
                detail: "When building, enable clang's leak sanitizer",
                optionName: "lsan",
              },
              {
                label: "Memory Sanitizer",
                detail: "When building, enable clang's memory sanitizer",
                optionName: "msan",
              },
              {
                label: "Thread Sanitizer",
                detail: "When building, enable clang's thread sanitizer",
                optionName: "tsan",
              },
            ];
            configOptionsQuickPick.canSelectMany = true;
            configOptionsQuickPick.step = 3;
            configOptionsQuickPick.totalSteps = 4;
            configOptionsQuickPick.onDidHide(() => {
              configOptionsQuickPick.dispose();
              resolve(undefined);
            });
            configOptionsQuickPick.onDidAccept(() => {
              resolve(configOptionsQuickPick.selectedItems);
              configOptionsQuickPick.dispose();
            });
            configOptionsQuickPick.show();
          });

          if (options === undefined) {
            return;
          }

          const cliOptions = options
            .filter((option) => option.optionName !== undefined)
            .map((option) => `--${option.optionName}`);
          const useFork = options.find(
            (quickPickItem) => quickPickItem.label === "Add Fork"
          );

          if (useFork) {
            const forkName = await new Promise<string | undefined>(
              (resolve) => {
                const forkNameInput = vscode.window.createInputBox();
                forkNameInput.title = "New Electron Build Tools Config";
                forkNameInput.placeholder = "Fork Name";
                forkNameInput.step = 4;
                forkNameInput.totalSteps = 4;
                forkNameInput.prompt =
                  "This should take the format 'username/electron'";
                forkNameInput.onDidHide(() => {
                  forkNameInput.dispose();
                  resolve(undefined);
                });
                forkNameInput.onDidAccept(() => {
                  resolve(forkNameInput.value);
                  forkNameInput.dispose();
                });
                forkNameInput.show();
              }
            );

            if (forkName === undefined) {
              return;
            }

            cliOptions.push(`--fork ${forkName}`);
          }

          await vscode.window.withProgress(
            { location: { viewId: viewIds.CONFIGS } },
            async () => {
              await exec(
                `${buildToolsExecutable} init ${cliOptions.join(
                  " "
                )} ${configName}`
              );
              await configsCollector.refreshConfigs();
            }
          );
        } catch (err) {
          Logger.error(err);
          vscode.window.showErrorMessage(
            `Failed to create new config: ${err.stderr.trim()}`
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      `${commandPrefix}.openConfig`,
      async (configName: string) => {
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
          Logger.error(e);
        }

        return configFilePath;
      }
    ),
    vscode.commands.registerCommand(
      `${commandPrefix}.useConfig.quickPick`,
      () => vscode.commands.executeCommand(`${commandPrefix}.useConfig`)
    ),
    vscode.commands.registerCommand(
      `${commandPrefix}.removeConfig`,
      async (config: ConfigTreeItem) => {
        try {
          await exec(`${buildToolsExecutable} remove ${config.label}`);

          // TBD - This isn't very noticeable
          vscode.window.setStatusBarMessage("Removed config");
        } catch (err) {
          Logger.error(err);
          vscode.window.showErrorMessage(
            `Failed to remove config: ${err.stderr.trim()}`
          );
          configsProvider.refresh();
        }
      }
    ),
    vscode.commands.registerCommand(
      `${commandPrefix}.sanitizeConfig`,
      async (config: ConfigTreeItem) => {
        try {
          await exec(`${buildToolsExecutable} sanitize-config ${config.label}`);

          // TBD - This isn't very noticeable
          vscode.window.setStatusBarMessage("Sanitized config");
        } catch (err) {
          Logger.error(err);
          vscode.window.showErrorMessage(
            `Failed to sanitize config: ${err.stderr.trim()}`
          );
        }
      }
    ),
    ExtensionState.registerExtensionOperationCommand(
      ExtensionOperation.CHANGE_CONFIG,
      `${commandPrefix}.useConfig`,
      () => {
        vscode.window.showErrorMessage(
          "Can't change configs, other work in-progress"
        );
      },
      async (value: { label: string } | string | undefined) => {
        if (value === undefined) {
          await sleep(50); // If this is too fast it has an ugly flash in VS Code
          const { configs, activeConfig } = await configsCollector.getConfigs();
          value = await vscode.window.showQuickPick<vscode.QuickPickItem>(
            configs.map((config) => ({
              label: config,
              description: config === activeConfig ? "Active" : undefined,
            }))
          );

          if (value === undefined || value.label === activeConfig) {
            return;
          }
        }

        const configName = (value as any).label ?? value;

        // Do an optimistic update for snappier UI
        configsProvider.setActive(configName);

        try {
          await exec(`${buildToolsExecutable} use ${configName}`);
        } catch (err) {
          Logger.error(err);
          vscode.window.showErrorMessage(
            "Failed to set active Electron build-tools config"
          );
          configsProvider.setActive(null);
          configsProvider.refresh();
        }
      }
    )
  );
}
