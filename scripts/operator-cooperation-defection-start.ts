import { webcrypto } from 'node:crypto';
import { createOperatorRelayAdapter } from '../src/lib/operatorRelayAdapter';
import {
	OperatorCancelled,
	OperatorFailure,
	runManualCooperationDefectionOperator
} from '../src/lib/operatorCooperationDefection';
import { PROTOTYPE_WORLD_CONFIG } from '../src/lib/prototypeWorldConfig';
import {
	confirmPublish,
	createHiddenInputSession,
	OperatorInputCancelled,
	OperatorInputEof,
	readHiddenNsec
} from './operatorInput';

function printUsage(): void {
	console.log('Usage: npm run operator:cooperation-defection:start');
	console.log('       npm run operator:cooperation-defection:publish');
	console.log('Default mode performs a signed dry-run without publishing.');
	console.log('The publish command requires hidden confirmation, then publishes to authoritative Relays.');
}

function parseMode(args: readonly string[]): 'dry-run' | 'publish' | 'help' {
	if (args.length === 0) return 'dry-run';
	if (args.length === 1 && args[0] === '--help') return 'help';
	if (args.length === 1 && args[0] === '--publish') return 'publish';
	throw new OperatorFailure('invalid configuration');
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	webcrypto.getRandomValues(bytes);
	return bytes;
}

async function main(): Promise<number> {
	let mode: 'dry-run' | 'publish';
	try {
		const parsed = parseMode(process.argv.slice(2));
		if (parsed === 'help') {
			printUsage();
			return 0;
		}
		mode = parsed;
	} catch {
		console.error('Invalid command-line options. Use --help for usage.');
		return 1;
	}

	const relay = createOperatorRelayAdapter();
	let inputSession: ReturnType<typeof createHiddenInputSession> | undefined;
	try {
		if (mode === 'publish') inputSession = createHiddenInputSession();
		await runManualCooperationDefectionOperator(mode, {
			relay,
			confirmPublish: inputSession?.confirmPublish ?? (() => confirmPublish()),
			readSecret: inputSession?.readHiddenNsec ?? (() => readHiddenNsec()),
			cancelSignal: inputSession?.signal,
			randomBytes,
			nowMs: () => Date.now(),
			output: {
				stdout: (line) => console.log(line),
				stderr: (line) => console.error(line)
			}
		}, PROTOTYPE_WORLD_CONFIG);
		return 0;
	} catch (error) {
		if (error instanceof OperatorCancelled || error instanceof OperatorInputCancelled) return 130;
		if (error instanceof OperatorInputEof) {
			console.error('Input ended before confirmation or secret entry completed.');
			return 130;
		}
		if (error instanceof OperatorFailure) {
			console.error(`Operator command failed: ${error.reason}.`);
			return error.code;
		}
		console.error('Operator command failed.');
		return 1;
	} finally {
		await inputSession?.close();
		relay.close();
	}
}

process.exitCode = await main();
