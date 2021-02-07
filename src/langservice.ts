/// <reference types="monaco-editor" />
import * as lean from 'lean-client-js-browser';
import {leanSyntax} from './syntax';
import * as translations from './translations.json';

export class CoalescedTimer {
  private timer: number = undefined;
  do(ms: number, f: () => void) {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      f();
    }, ms) as any;
  }
}

export class ReactiveValue<E> {
  updated = new lean.Event<E>();
  private lastValue: E;

  constructor(initialValue: E) {
    this.lastValue = initialValue;
    this.updated.on((e) => this.lastValue = e);
  }

  get value() { return this.lastValue; }
}

export let server: lean.Server;
export let allMessages: lean.Message[] = [];

export const currentlyRunning = new ReactiveValue<string[]>([]);
function addToRunning(fn: string) {
  if (currentlyRunning.value.indexOf(fn) === -1) {
    currentlyRunning.updated.fire([].concat([fn], currentlyRunning.value));
  }
}
function removeFromRunning(fn: string) {
  currentlyRunning.updated.fire(currentlyRunning.value.filter((v) => v !== fn));
}

const watchers = new Map<string, ModelWatcher>();

export let delayMs = 1000;

class ModelWatcher implements monaco.IDisposable {
  private changeSubscription: monaco.IDisposable;
  private syncTimer = new CoalescedTimer();
  private version = 0;

  constructor(private model: monaco.editor.IModel) {
    this.changeSubscription = model.onDidChangeContent((e) => {
      completionBuffer.cancel();
      // this.checkInputCompletion(e);
      this.syncIn(delayMs);
    });
    this.syncNow();
  }

  dispose() { this.changeSubscription.dispose(); }

  syncIn(ms: number) {
    addToRunning(this.model.uri.fsPath);
    completionBuffer.cancel();
    const version = (this.version += 1);
    this.syncTimer.do(ms, () => {
      if (!server) {
        return;
      }
      server.sync(this.model.uri.fsPath, this.model.getValue()).then(() => {
        if (this.version === version) {
          removeFromRunning(this.model.uri.fsPath);
        }
      });
    });
  }

  syncNow() { this.syncIn(0); }
}

const triggerChars = new Set(' ,');
export function checkInputCompletionChange(e: monaco.editor.IModelContentChangedEvent,
                                           editor: monaco.editor.IStandaloneCodeEditor,
                                           model: monaco.editor.IModel): void {
  if (e.changes.length !== 1) {
    return null;
  }
  const change = e.changes[0];
  if (change.rangeLength === 0 && triggerChars.has(change.text)) {
    completionEdit(editor, model, true);
  }
  return null;
}

// completionEdit() assumes that all these are 2 characters long!
const hackyReplacements = {
  ['{{}}']: '⦃⦄',
  ['[[]]']: '⟦⟧',
  ['<>']: '⟨⟩',
  ['([])']: '⟮⟯',
  ['f<>']: '‹›',
  ['f<<>>']: '«»',
};
export function checkInputCompletionPosition(e: monaco.editor.ICursorPositionChangedEvent,
                                             editor: monaco.editor.IStandaloneCodeEditor,
                                             model: monaco.editor.IModel): boolean {
  const lineNum = e.position.lineNumber;
  const line = model.getLineContent(lineNum);
  const cursorPos = e.position.column;
  const index = line.lastIndexOf('\\', cursorPos - 1) + 1;
  const match = line.substring(index, cursorPos - 1);
  // ordinary completion
  const replaceText = index && translations[match];
  // hacky completions put the cursor between paired Unicode brackets
  const hackyReplacement = index && hackyReplacements[match];
  return replaceText || hackyReplacement;
}

function completionEdit(editor: monaco.editor.IStandaloneCodeEditor,
                        model: monaco.editor.IModel, triggeredByTyping: boolean): void {
  const sel = editor.getSelections();
  const lineNum = sel[0].startLineNumber;
  const line = model.getLineContent(lineNum);
  const cursorPos = sel[0].startColumn;
  const index = line.lastIndexOf('\\', cursorPos - 1) + 1;
  const match = line.substring(index, cursorPos - 1);
  // ordinary completion
  const replaceText = index && translations[match];
  // hacky completions put the cursor between paired Unicode brackets
  const hackyReplacement = index && hackyReplacements[match];
  if (replaceText || hackyReplacement) {
    if (triggeredByTyping) {
      const range1 = new monaco.Range(lineNum, index, lineNum, cursorPos);
      editor.executeEdits(null, [{
        identifier: {major: 1, minor: 1},
        range: range1,
        text: replaceText || hackyReplacement[0],
        forceMoveMarkers: false,
      }], [new monaco.Selection(lineNum, index + 1, lineNum, index + 1)]);
      if (hackyReplacement) {
        // put the closing bracket after the typed character
        const range2 = new monaco.Range(lineNum, index + 2, lineNum, index + 2);
        editor.executeEdits(null, [{
          identifier: {major: 1, minor: 1},
          range: range2,
          text: hackyReplacement[1],
          forceMoveMarkers: false,
        }], [new monaco.Selection(lineNum, index + 1, lineNum, index + 1)]);
      }
      // HACK: monaco seems to move the cursor AFTER the onDidChangeModel event handlers are called,
      // so we move the cursor +1 character to the right so that it's immediately after the typed character
      // (assumes all unicode translations are 1 character long and
      // all hackyReplacements have a 1-character opening brace!)
      global.setTimeout(() => editor.setPosition(new monaco.Position(lineNum, index + 2)), 0);
    } else {
      const range = new monaco.Range(lineNum, index, lineNum, cursorPos);
      editor.executeEdits(null, [{
        identifier: {major: 1, minor: 1},
        range,
        text: replaceText || hackyReplacement,
        forceMoveMarkers: false,
      }], [new monaco.Selection(lineNum, index + 1, lineNum, index + 1)]);
      // index + 1: the final cursor position is one character to the right of the initial '\'
      // (assumes all unicode translations are 1 character long and
      // all hackyReplacements have a 1-character opening brace!)
    }
  }
}

export function tabHandler(editor: monaco.editor.IStandaloneCodeEditor,
                           model: monaco.editor.IModel): void {
  completionEdit(editor, model, false);
}

class CompletionBuffer {
    private reject: (reason: any) => void;
    private timer;

    wait(ms: number): Promise<void> {
        this.cancel();
        return new Promise<void>((resolve, reject) => {
            this.reject = reject;
            this.timer = setTimeout(() => {
                this.timer = undefined;
                resolve();
            }, ms);
        });
    }
    cancel() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.reject('timeout');
            this.timer = undefined;
        }
    }
}
const completionBuffer = new CompletionBuffer();

function toSeverity(severity: lean.Severity): monaco.Severity {
  switch (severity) {
    case 'warning': return monaco.Severity.Warning;
    case 'error': return monaco.Severity.Error;
    case 'information': return monaco.Severity.Info;
  }
}

export function registerLeanLanguage(leanJsOpts: lean.LeanJsOpts) {
  if (server) {
    return;
  }

  const transport = new lean.WebWorkerTransport(leanJsOpts);
  server = new lean.Server(transport);
  server.error.on((err) => console.log('error:', err));
  server.connect();
  // server.logMessagesToConsole = true;
  server.logMessagesToConsole = window.localStorage.getItem('logging') === 'true';

  monaco.languages.register({
    id: 'lean',
    filenamePatterns: ['*.lean'],
  });

  monaco.editor.onDidCreateModel((model) => {
    if (model.getModeId() === 'lean') {
        watchers.set(model.uri.fsPath, new ModelWatcher(model));
    }
  });
  monaco.editor.onWillDisposeModel((model) => {
      const watcher = watchers.get(model.uri.fsPath);
      if (watcher) {
          watcher.dispose();
          watchers.delete(model.uri.fsPath);
      }
  });

  server.allMessages.on((allMsgs) => {
    allMessages = allMsgs.msgs;
    for (var msg of allMessages) {
      console.log(msg.text);
    }
    if (allMessages.length == 0) {
      console.log("goals accomplished");
      // continue playing video and set timeout to pause it at next mark.
    //   if (window.hasOwnProperty('playVideo')) {
    //     window['playVideo'].call();
    // }
      let snd2 = new Audio("data:audio/mpeg;base64,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wZ0G7jqlt/OcDIKX+/1NblSX+VKfQfP8xuJJGk7////rf////+PgXTv///1JThJJQainmySAB6imUyuVbVttUo7T4Csa821OuF88f62+CZHFnGf///mQgYIEO0SMF2NVy9NxYTdlqJ8AuS4zr//SJoTUJ+CaKKTcZvosrUPo8W/MUv0f033E9E/QpN6P///v/////WRR2mwUAYUABjabRu1vrOLKAF0kIdHjnEx/iNWo7jGn1////mApxNTJQQOU1Het/NoUFTMQs6Vja///THaGIl/0fojl8mjd/Jo8W+ZfpNpCajsz7////6kn/////WRRgDz//LD1KSTDjKOciSAKxdLx5S31uYqKIWj/+5JECgAC8V5M6g9rdFyr6Vo9rW6KtHcr5DEJQRkSpLRklSigvVc4QpmyPe9H3zHR1/in9P/8VNCMJOzYUDyVjfwHP0ZgiZt/3/+9EBnDKbegdUrckhgntHaQ9vX/X/9A/////+r/////mJ3/9ItRcoVRogAcmV9N8z0pvES8QQsKoMGXEymPQyWm6E4HQLqgpv/CZJAtYXQSwoF8e6SB56zABEoW+qgZjJAZovGr0Gl5/OjFKL3JwnaX9v7/X8y1f/////////49WAzMzEYYMZLq6CUANIqbDX7lisBIdraAEPwShTRc9WZ2vAqBc4NQ9GrUNaw0Czcrte0g1NEoiU8NFjx4NFh54FSwlOlgaCp0S3hqo8SLOh3/63f7P/KgKJxxhgGSnAFMCnIogwU5JoqBIDAuBIiNLETyFmiImtYiDTSlb8ziIFYSFv/QPC38zyxEOuPeVGHQ77r/1u/+kq49//6g4gjoVQSUMYQUSAP8PwRcZIyh2kCI2OwkZICZmaZxgnsNY8DmSCWX0idhtz3VTJSqErTSB//1X7TTTVVV//uSZB2P8xwRJ4HvYcItQlWBACM4AAABpAAAACAAADSAAAAEVf/+qCE000VVVVU0002//+qqqqummmmr///qqqppppoqqqqppppoqqATkEjIyIxBlBA5KwUEDBBwkFhYWFhUVFfiqhYWFhcVFRUVFv/Ff/xUVFRYWFpMQU1FMy45OS41qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg==");
      function beep2() { 
        snd2.play();
      }
      beep2();
      // Note: assign a mark (timestamp) to each theorem, if possible; And 
      // when the goals of the theorem are accomplished play the next the 
      // next segment of the video.
    }
    for (const model of monaco.editor.getModels()) {
      const fn = model.uri.fsPath;
      const markers: monaco.editor.IMarkerData[] = [];
      for (const msg of allMsgs.msgs) {
        if (msg.file_name !== fn) {
          continue;
        }
        const marker: monaco.editor.IMarkerData = {
          severity: toSeverity(msg.severity),
          message: msg.text,
          startLineNumber: msg.pos_line,
          startColumn: msg.pos_col + 1,
          endLineNumber: msg.pos_line,
          endColumn: msg.pos_col + 1,
        };
        if (msg.end_pos_line && msg.end_pos_col !== undefined) {
          marker.endLineNumber = msg.end_pos_line;
          marker.endColumn = msg.end_pos_col + 1;
        }
        markers.push(marker);
      }
      monaco.editor.setModelMarkers(model, 'lean', markers);
    }
  });

  monaco.languages.registerCompletionItemProvider('lean', {
    provideCompletionItems: (editor, position) =>
      completionBuffer.wait(delayMs).then(() => {
        watchers.get(editor.uri.fsPath).syncNow();
        return server.complete(editor.uri.fsPath, position.lineNumber, position.column - 1).then((result) => {
            const items: monaco.languages.CompletionItem[] = [];
            for (const compl of result.completions || []) {
            const item = {
                kind: monaco.languages.CompletionItemKind.Function,
                label: compl.text,
                detail: compl.type,
                documentation: compl.doc,
                range: new monaco.Range(position.lineNumber, position.column - result.prefix.length,
                    position.lineNumber, position.column),
            };
            if (compl.tactic_params) {
                item.detail = compl.tactic_params.join(' ');
            }
            items.push(item);
            }
            return items;
        });
    }, () => undefined),
  });

  monaco.languages.registerHoverProvider('lean', {
    provideHover: (editor, position): Promise<monaco.languages.Hover> => {
      return server.info(editor.uri.fsPath, position.lineNumber, position.column - 1).then((response) => {
        const marked: monaco.MarkedString[] = [];
        const record = response.record;
        if (!record) {
            return {contents: []} as monaco.languages.Hover;
        }
        const name = record['full-id'] || record.text;
        if (name) {
          if (response.record.tactic_params) {
            marked.push({
              language: 'text',
              value: name + ' ' + record.tactic_params.join(' '),
            });
          } else {
            marked.push({
              language: 'lean',
              value: name + ' : ' + record.type,
            });
          }
        }
        if (response.record.doc) {
          marked.push(response.record.doc);
        }
        if (response.record.state) {
          marked.push({language: 'lean', value: record.state});
        }
        return {
          contents: marked,
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
        };
      });
    },
  });

  monaco.languages.setMonarchTokensProvider('lean', leanSyntax as any);
}
