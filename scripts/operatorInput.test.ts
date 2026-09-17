import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { confirmPublish, OperatorInputCancelled, OperatorInputEof, readHiddenLine, type HiddenLineIo } from './operatorInput';

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
});
