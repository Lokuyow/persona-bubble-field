import { EventEmitter } from 'node:events';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';
import { describe, expect, it } from 'vitest';
import { confirmPublish, OperatorInputCancelled, OperatorInputEof, readHiddenLine, readHiddenNsec, type HiddenLineIo } from './operatorInput';

class FakeTty extends EventEmitter {
	isTTY = true;
	rawModes: boolean[] = [];
	encodings: (BufferEncoding | null)[] = [];
	setRawMode(value: boolean): void { this.rawModes.push(value); }
	setEncoding(value: BufferEncoding | null): void { this.encodings.push(value); }
}

function io(input: FakeTty): { io: HiddenLineIo; output: { isTTY: true; text: string } } {
	const output = { isTTY: true as const, text: '' };
	return { io: { input, output: { ...output, write: (value: string) => { output.text += value; return true; } } }, output };
}

describe('operator hidden TTY input', () => {
	it('does not echo a pasted fake nsec in the confirmation prompt', async () => {
		const input = new FakeTty();
		const streams = io(input);
		const pending = confirmPublish(streams.io);
		input.emit('data', 'nsec1fake-secret-value\n');
		expect(await pending).toBe('cancelled');
		expect(streams.output.text).not.toContain('nsec1fake-secret-value');
		expect(input.rawModes).toEqual([true, false]);
		expect(input.encodings.at(-1)).toBeNull();
	});

	it('restores TTY state on Ctrl+C and EOF without displaying input', async () => {
		const input = new FakeTty();
		const streams = io(input);
		const cancelled = readHiddenLine('secret: ', streams.io);
		input.emit('data', '\u0003');
		await expect(cancelled).rejects.toBeInstanceOf(OperatorInputCancelled);
		expect(input.rawModes).toEqual([true, false]);

		const eofInput = new FakeTty();
		const eofStreams = io(eofInput);
		const eof = readHiddenLine('secret: ', eofStreams.io);
		eofInput.emit('end');
		await expect(eof).rejects.toBeInstanceOf(OperatorInputEof);
		expect(eofStreams.output.text).toBe('secret: ');
		expect(eofInput.rawModes).toEqual([true, false]);
	});

	it('transfers decoded nsec bytes to the caller for zeroization ownership', async () => {
		const input = new FakeTty();
		const streams = io(input);
		const pending = readHiddenNsec(streams.io);
		input.emit('data', `${nsecEncode(new Uint8Array(32).fill(3))}\n`);
		const secret = await pending;
		expect(secret).toHaveLength(32);
		secret.fill(0);
		expect(secret.every((byte) => byte === 0)).toBe(true);
	});

	it('rejects non-nsec input without displaying it', async () => {
		const input = new FakeTty();
		const streams = io(input);
		const pending = readHiddenNsec(streams.io);
		input.emit('data', `${npubEncode('04'.repeat(32))}\n`);
		await expect(pending).rejects.toThrow('invalid nsec');
		expect(streams.output.text).toBe('nsec: ');
	});
});
