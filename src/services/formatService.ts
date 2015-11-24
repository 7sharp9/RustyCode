import * as vscode from 'vscode';
import * as cp from 'child_process';

import PathService from './pathService';

const AnsiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export default class FormatService implements vscode.DocumentFormattingEditProvider {
    private writeMode: string;

    constructor() {
        this.writeMode = 'diff';
    }

    public provideDocumentFormattingEdits(document: vscode.TextDocument): Thenable<vscode.TextEdit[]> {
        return document.save().then(() => {
            return this.performFormatFile(document, this.writeMode);
        });
    }

    private formatCommand(fileName: string, writeMode: string): string {
        return PathService.getRustfmtPath() + ' --write-mode=' + writeMode + ' ' + fileName;
    }

    private cleanDiffLine(line: string): string {
        if (line.endsWith('\u23CE')) {
            return line.slice(1, -1) + '\n';
        }

        return line.slice(1);
    }

    private stripColorCodes(input: string): string {
        return input.replace(AnsiRegex, '');
    }
    
    private parseDiff(fileToProcess: vscode.Uri, diff: string): vscode.TextEdit[] {
        let patches = [];
        let currentPatch;
        let currentFile: vscode.Uri;

        diff = this.stripColorCodes(diff);

        for (let line of diff.split(/\n/)) {
            if (line.startsWith('Diff of')) {
                currentFile = vscode.Uri.file(line.slice('Diff of '.length, -1));
            }

            if(!currentFile) {
                continue;
            }

            if (currentFile.toString() === fileToProcess.toString()) {
                if (line.startsWith('Diff at line')) {
                    if (currentPatch != null) {
                        patches.push(currentPatch);
                    }

                    currentPatch = {
                        startLine: parseInt(line.slice('Diff at line'.length), 10),
                        newLines: [],
                        removedLines: 0
                    };
                } else if (line.startsWith('+')) {
                    currentPatch.newLines.push(this.cleanDiffLine(line));
                } else if (line.startsWith('-')) {
                    currentPatch.removedLines += 1;
                } else if (line.startsWith(' ')) {
                    currentPatch.newLines.push(this.cleanDiffLine(line));
                    currentPatch.removedLines += 1;
                }
            }
        }

        if (currentPatch) {
            patches.push(currentPatch);
        }

        let cummulativeOffset = 0;
        let textEdits = patches.map(patch => {
            let startLine = patch.startLine - 1 + cummulativeOffset;
            let removedLines = patch.removedLines;
            cummulativeOffset += (removedLines - patch.newLines.length);
            let rangeEndLine = removedLines == 0 ? startLine : startLine + removedLines - 1;
            let range = new vscode.Range(startLine, 0, rangeEndLine, Number.MAX_SAFE_INTEGER);
            let patchLines = patch.newLines;
            let lastLineIndex = patchLines.length - 1;
            patchLines[lastLineIndex] = patchLines[lastLineIndex].replace("\n", "");
            let edit = vscode.TextEdit.replace(range, patchLines.join(''));
            return edit;
        });
        console.log(textEdits);
        return textEdits;
    }

    private performFormatFile(document: vscode.TextDocument, writeMode: string): Promise<vscode.TextEdit[]> {
        return new Promise((resolve, reject) => {
            let fileName = document.fileName;
            let command = this.formatCommand(fileName, writeMode);

            cp.exec(command, (err, stdout) => {
                try {
                    if (err && (<any>err).code == 'ENOENT') {
                        vscode.window.showInformationMessage('The "rustfmt" command is not available. Make sure it is installed.');
                        return resolve(null);
                    }
                    if (err) {
                        return reject('Cannot format due to syntax errors');
                    }
                    
                    return resolve(this.parseDiff(document.uri, stdout.toString()));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }
}
