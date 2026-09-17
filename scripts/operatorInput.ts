import { decode } from 'nostr-tools/nip19';

export class OperatorInputCancelled extends Error {}
export class OperatorInputEof extends Error {}

type ReadableTty = NodeJS.ReadableStream & {
	isTTY?: boolean;
	setRawMode?: (mode: boolean) => void;
	setEncoding?: (encoding: BufferEncoding | null) => void;
};

export type HiddenLineIo = Readonly<{
	input?: ReadableTty;
	output?: NodeJS.WritableStream & { isTTY?: boolean };
}>;

function inputStream(): ReadableTty {
	return process.stdin as ReadableTty;
}

export async function readHiddenLine(prompt: string, io: HiddenLineIo = {}): Promise<string> {
	const input = io.input ?? inputStream();
	const output = io.output ?? process.stdout;
	if (!input.isTTY || !output.isTTY || !input.setRawMode || !input.setEncoding) {
		throw new Error('interactive TTY is required');
	}
	output.write(prompt);
	return await new Promise<string>((resolve, reject) => {
		let value = '';
		let settled = false;
		const cleanup = (): void => {
			input.off('data', onData);
			input.off('end', onEnd);
			input.off('close', onClose);
			try { input.setRawMode!(false); } catch { /* restore is best effort */ }
			try { input.setEncoding!(null); } catch { /* restore is best effort */ }
		};
		const finish = (result: Readonly<{ value?: string; error?: Error }>): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (result.error) reject(result.error);
			else resolve(result.value ?? '');
		};
		const onData = (chunk: string): void => {
			for (const character of chunk) {
				if (character === '\u0003') {
					finish({ error: new OperatorInputCancelled() });
					return;
				}
				if (character === '\r' || character === '\n') {
					finish({ value });
					return;
				}
				if (character === '\b' || character === '\u007f') value = value.slice(0, -1);
				else if (character >= ' ' && character !== '\u007f') value += character;
			}
		};
		const onEnd = (): void => finish({ error: new OperatorInputEof() });
		const onClose = (): void => finish({ error: new OperatorInputEof() });
		try {
			input.setRawMode!(true);
			input.setEncoding!('utf8');
			input.on('data', onData);
			input.once('end', onEnd);
			input.once('close', onClose);
		} catch (error) {
			void error;
			finish({ error: new Error('TTY setup failed') });
		}
	});
}

export async function readHiddenNsec(io?: HiddenLineIo): Promise<Uint8Array> {
	const encoded = await readHiddenLine('nsec: ', io);
	const decoded = decode(encoded);
	if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array) || decoded.data.length !== 32) {
		if (decoded.data instanceof Uint8Array) decoded.data.fill(0);
		throw new Error('invalid nsec');
	}
	return decoded.data;
}

export async function confirmPublish(io?: HiddenLineIo): Promise<'confirmed' | 'cancelled'> {
	try {
		const confirmed = (await readHiddenLine('Type PUBLISH to confirm: ', io)) === 'PUBLISH';
		if (confirmed) (io?.output ?? process.stdout).write('Confirmation accepted.\n');
		return confirmed ? 'confirmed' : 'cancelled';
	} catch (error) {
		if (error instanceof OperatorInputCancelled || error instanceof OperatorInputEof) return 'cancelled';
		throw error;
	}
}
