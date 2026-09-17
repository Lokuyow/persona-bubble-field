import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';
import type { Key } from 'node:readline';
import { decode } from 'nostr-tools/nip19';

export class OperatorInputCancelled extends Error {}
export class OperatorInputEof extends Error {}

type ReadableTty = NodeJS.ReadableStream & {
	isTTY?: boolean;
};

export type HiddenLineIo = Readonly<{
	input?: ReadableTty;
	output?: NodeJS.WritableStream & { isTTY?: boolean };
}>;

export type HiddenInputSession = Readonly<{
	signal: AbortSignal;
	readLine: (prompt: string) => Promise<string>;
	confirmPublish: () => Promise<'confirmed' | 'cancelled'>;
	readHiddenNsec: () => Promise<Uint8Array>;
	close: () => Promise<void>;
}>;

function inputStream(): ReadableTty {
	return process.stdin as ReadableTty;
}

function assertInteractiveTty(input: ReadableTty, output: NodeJS.WritableStream & { isTTY?: boolean }): void {
	if (!input.isTTY || !output.isTTY) throw new Error('interactive TTY is required');
}

/** Own one readline Interface for the whole hidden-input portion of a command. */
export function createHiddenInputSession(io: HiddenLineIo = {}): HiddenInputSession {
	const input = io.input ?? inputStream();
	const output = io.output ?? process.stdout;
	assertInteractiveTty(input, output);

	const commandController = new AbortController();
	let rl: ReadlineInterface | undefined;
	let activeQuestionController: AbortController | undefined;
	let termination: 'cancelled' | 'eof' | undefined;
	let intentionalClose = false;
	let closed = false;
	let discarding = false;
	let discardPromise: Promise<void> | undefined;
	class DiscardGapStopped extends Error {}

	const abortActiveQuestion = (): void => activeQuestionController?.abort();
	const markTermination = (reason: 'cancelled' | 'eof'): void => {
		if (termination) return;
		termination = reason;
		commandController.abort();
		abortActiveQuestion();
	};
	const onSigint = (): void => markTermination('cancelled');
	const onInputEnd = (): void => markTermination('eof');
	const onInputClose = (): void => markTermination('eof');
	const onInterfaceClose = (): void => {
		if (!intentionalClose) markTermination('eof');
	};

	const ensureReadline = (): ReadlineInterface => {
		if (rl) return rl;
		try {
			rl = createInterface({ input, terminal: true, historySize: 0, crlfDelay: Infinity });
			rl.on('SIGINT', onSigint);
			rl.on('close', onInterfaceClose);
			input.on('end', onInputEnd);
			input.on('close', onInputClose);
			return rl;
		} catch {
			throw new Error('TTY setup failed');
		}
	};

	const throwTermination = (): never => {
		if (termination === 'cancelled') throw new OperatorInputCancelled();
		if (termination === 'eof' || closed) throw new OperatorInputEof();
		throw new Error('TTY input failed');
	};

	const readLine = async (prompt: string): Promise<string> => {
		if (termination || closed) throwTermination();
		const readline = ensureReadline();
		output.write(prompt);
		const questionController = new AbortController();
		activeQuestionController = questionController;
		try {
			return await readline.question('', { signal: questionController.signal });
		} catch {
			if (!termination && !discarding && questionController.signal.aborted) throw new DiscardGapStopped();
			return throwTermination();
		} finally {
			if (activeQuestionController === questionController) activeQuestionController = undefined;
		}
	};

	const discardGap = async (): Promise<void> => {
		while (discarding && !termination && !closed) {
			try {
				await readLine('');
			} catch (error) {
				if (error instanceof DiscardGapStopped) return;
				if (error instanceof OperatorInputCancelled || error instanceof OperatorInputEof) return;
				throw error;
			}
		}
	};

	const beginDiscardGap = (): void => {
		discarding = true;
		discardPromise = discardGap();
	};

	const clearEditingLine = (): void => {
		ensureReadline().write(null, { ctrl: true, name: 'u' } satisfies Key);
	};

	const endDiscardGap = async (): Promise<void> => {
		discarding = false;
		activeQuestionController?.abort();
		await discardPromise;
		discardPromise = undefined;
		if (!termination && !closed) clearEditingLine();
	};

	const confirmPublish = async (): Promise<'confirmed' | 'cancelled'> => {
		try {
			const confirmed = (await readLine('Type PUBLISH to confirm: ')) === 'PUBLISH';
			if (confirmed) {
				output.write('Confirmation accepted.\n');
				beginDiscardGap();
			}
			return confirmed ? 'confirmed' : 'cancelled';
		} catch (error) {
			if (error instanceof OperatorInputCancelled || error instanceof OperatorInputEof) return 'cancelled';
			throw error;
		}
	};

	const readHiddenNsec = async (): Promise<Uint8Array> => {
		if (discardPromise) await endDiscardGap();
		else if (!termination && !closed) clearEditingLine();
		const encoded = await readLine('nsec: ');
		let decoded: ReturnType<typeof decode>;
		try {
			decoded = decode(encoded);
		} catch {
			throw new Error('invalid nsec');
		}
		if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array) || decoded.data.length !== 32) {
			if (decoded.data instanceof Uint8Array) decoded.data.fill(0);
			throw new Error('invalid nsec');
		}
		return decoded.data;
	};

	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		discarding = false;
		intentionalClose = true;
		commandController.abort();
		abortActiveQuestion();
		try { rl?.close(); } catch { /* restoration is best effort */ }
		try { await discardPromise; } catch { /* cleanup must not mask command results */ }
		if (rl) {
			rl.off('SIGINT', onSigint);
			rl.off('close', onInterfaceClose);
			input.off('end', onInputEnd);
			input.off('close', onInputClose);
		}
	};

	return { signal: commandController.signal, readLine, confirmPublish, readHiddenNsec, close };
}

export async function readHiddenLine(prompt: string, io: HiddenLineIo = {}): Promise<string> {
	const session = createHiddenInputSession(io);
	try {
		return await session.readLine(prompt);
	} finally {
		await session.close();
	}
}

export async function readHiddenNsec(io?: HiddenLineIo): Promise<Uint8Array> {
	const session = createHiddenInputSession(io);
	try { return await session.readHiddenNsec(); }
	finally { await session.close(); }
}

export async function confirmPublish(io?: HiddenLineIo): Promise<'confirmed' | 'cancelled'> {
	const session = createHiddenInputSession(io);
	try { return await session.confirmPublish(); }
	finally { await session.close(); }
}
