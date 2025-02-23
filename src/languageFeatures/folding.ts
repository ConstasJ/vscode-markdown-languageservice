/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as lsp from 'vscode-languageserver-protocol';
import { ILogger, LogLevel } from '../logging';
import { IMdParser, Token, TokenWithMap } from '../parser';
import { MdTableOfContentsProvider } from '../tableOfContents';
import { getLine, ITextDocument } from '../types/textDocument';
import { isEmptyOrWhitespace } from '../util/string';

const rangeLimit = 5000;

interface RegionMarker {
	readonly token: TokenWithMap;
	readonly isStart: boolean;
}

export class MdFoldingProvider {

	readonly #parser: IMdParser;
	readonly #tocProvider: MdTableOfContentsProvider;
	readonly #logger: ILogger;

	constructor(
		parser: IMdParser,
		tocProvider: MdTableOfContentsProvider,
		logger: ILogger,
	) {
		this.#parser = parser;
		this.#tocProvider = tocProvider;
		this.#logger = logger;
	}

	public async provideFoldingRanges(document: ITextDocument, token: lsp.CancellationToken): Promise<lsp.FoldingRange[]> {
		this.#logger.log(LogLevel.Debug, 'MdFoldingProvider.provideFoldingRanges', { document: document.uri, version: document.version });

		const foldables = await Promise.all([
			this.#getRegions(document, token),
			this.#getHeaderFoldingRanges(document, token),
			this.#getBlockFoldingRanges(document, token),
			this.#getTabIndentFoldingRanges(document)
		]);
		const result = foldables.flat();
		return result.length > rangeLimit ? result.slice(0, rangeLimit) : result;
	}

	async #getRegions(document: ITextDocument, token: lsp.CancellationToken): Promise<lsp.FoldingRange[]> {
		const tokens = await this.#parser.tokenize(document);
		if (token.isCancellationRequested) {
			return [];
		}

		return Array.from(this.#getRegionsFromTokens(tokens));
	}

	*#getRegionsFromTokens(tokens: readonly Token[]): Iterable<lsp.FoldingRange> {
		const nestingStack: RegionMarker[] = [];
		for (const token of tokens) {
			const marker = asRegionMarker(token);
			if (marker) {
				if (marker.isStart) {
					nestingStack.push(marker);
				} else if (nestingStack.length && nestingStack[nestingStack.length - 1].isStart) {
					yield { startLine: nestingStack.pop()!.token.map[0], endLine: marker.token.map[0], kind: lsp.FoldingRangeKind.Region };
				} else {
					// noop: invalid nesting (i.e. [end, start] or [start, end, end])
				}
			}
		}
	}

	async #getHeaderFoldingRanges(document: ITextDocument, token: lsp.CancellationToken): Promise<lsp.FoldingRange[]> {
		const toc = await this.#tocProvider.getForDocument(document);
		if (token.isCancellationRequested) {
			return [];
		}

		return toc.entries.map((entry): lsp.FoldingRange => {
			let endLine = entry.sectionLocation.range.end.line;
			if (isEmptyOrWhitespace(getLine(document, endLine)) && endLine >= entry.line + 1) {
				endLine = endLine - 1;
			}
			return { startLine: entry.line, endLine };
		});
	}

	async #getBlockFoldingRanges(document: ITextDocument, token: lsp.CancellationToken): Promise<lsp.FoldingRange[]> {
		const tokens = await this.#parser.tokenize(document);
		if (token.isCancellationRequested) {
			return [];
		}
		return Array.from(this.#getBlockFoldingRangesFromTokens(document, tokens));
	}

	*#getBlockFoldingRangesFromTokens(document: ITextDocument, tokens: readonly Token[]): Iterable<lsp.FoldingRange> {
		for (const token of tokens) {
			if (isFoldableToken(token)) {
				const startLine = token.map[0];
				let endLine = token.map[1] - 1;
				if (isEmptyOrWhitespace(getLine(document, endLine)) && endLine >= startLine + 1) {
					endLine = endLine - 1;
				}

				if (endLine > startLine) {
					yield { startLine, endLine, kind: this.#getFoldingRangeKind(token) };
				}
			}
		}
	}

	#getFoldingRangeKind(listItem: Token): lsp.FoldingRangeKind | undefined {
		return listItem.type === 'html_block' && listItem.content.startsWith('<!--')
			? lsp.FoldingRangeKind.Comment
			: undefined;
	}

	async #getTabIndentFoldingRanges(document: ITextDocument): Promise<lsp.FoldingRange[]> {
        const foldingRanges: lsp.FoldingRange[] = [];
        const stack: Array<{ indent: number, startLine: number }> = [];
        
        for (let line = 0; line < document.lineCount; line++) {
            const text = getLine(document, line);
            const indent = getIndentCount(text);

            while (stack.length && indent < stack[stack.length - 1].indent) {
                const { startLine } = stack.pop()!;
                if (line - startLine > 1) {
                    foldingRanges.push({ startLine, endLine: line - 1 });
                }
            }

            const lastIndent = stack.length ? stack[stack.length - 1].indent : 0;
            if (indent > lastIndent) {
                stack.push({ indent, startLine: line > 0 ? line - 1 : line });
            }
        }

        while (stack.length) {
            const { startLine } = stack.pop()!;
            if (document.lineCount - startLine > 1) {
                foldingRanges.push({ startLine, endLine: document.lineCount - 1 });
            }
        }

        return foldingRanges;
    }
}

function isStartRegion(t: string) { return /^\s*<!--\s*#?region\b.*-->/.test(t); }
function isEndRegion(t: string) { return /^\s*<!--\s*#?endregion\b.*-->/.test(t); }

function asRegionMarker(token: Token): RegionMarker | undefined {
	if (!token.map || token.type !== 'html_block') {
		return undefined;
	}

	if (isStartRegion(token.content)) {
		return { token: token as TokenWithMap, isStart: true };
	}

	if (isEndRegion(token.content)) {
		return { token: token as TokenWithMap, isStart: false };
	}

	return undefined;
}

function isFoldableToken(token: Token): token is TokenWithMap {
	if (!token.map) {
		return false;
	}

	switch (token.type) {
		case 'fence':
		case 'list_item_open':
		case 'table_open':
		case 'blockquote_open':
			return token.map[1] > token.map[0];

		case 'html_block':
			if (asRegionMarker(token)) {
				return false;
			}
			return token.map[1] > token.map[0] + 1;

		default:
			return false;
	}
}

function getIndentCount(text: string): number {
    let count = 0;
    let i = 0;
    while (i < text.length) {
        if (text.startsWith('\t', i)) {
            count++;
            i++;
        } else if (text.startsWith('    ', i)) {
            count++;
            i += 4;
        } else {
            break;
        }
    }
    return count;
}