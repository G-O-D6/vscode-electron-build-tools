import { exec as callbackExec } from "child_process";
import * as path from "path";
import * as querystring from "querystring";
import { promisify } from "util";

import * as vscode from "vscode";

import { patchOverviewMarkdown } from "./utils";

const exec = promisify(callbackExec);

export class TextDocumentContentProvider
  implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { checkoutPath, gitObject, view } = querystring.parse(uri.query);
    let content = "";

    if (view === "contents") {
      const relativeFilePath = path
        .relative(checkoutPath as string, uri.fsPath)
        .split(path.sep)
        .join(path.posix.sep);

      const gitCommand = `git show ${gitObject as string}:${relativeFilePath}`;

      const { stdout } = await exec(gitCommand, {
        encoding: "utf8",
        cwd: checkoutPath as string,
      });
      content = stdout.trim();
    } else if (view === "patch-overview") {
      content = (
        await patchOverviewMarkdown(uri.with({ scheme: "file", query: "" }))
      ).value;
    } else {
      throw new Error("Unknown view");
    }

    return content;
  }
}
