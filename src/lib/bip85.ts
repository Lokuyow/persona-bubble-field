import { HDKey } from '@scure/bip32';

const BIP85_ENTROPY_KEY = new TextEncoder().encode('bip-entropy-from-k');
const HARDENED_MIN = 1;
const HARDENED_MAX = 0x7fffffff;
const BIP85_PURPOSE = 83696968;
const NOSTR_APPLICATION = 128002;

export const BIP85_INDEX_MIN = HARDENED_MIN;
export const BIP85_INDEX_MAX = HARDENED_MAX;

export function assertBip85Index(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < BIP85_INDEX_MIN || value > BIP85_INDEX_MAX) {
		throw new RangeError(`${name} must be a BIP85 base index.`);
	}
}

function webCrypto(): Crypto {
	const cryptoApi = globalThis.crypto;
	if (!cryptoApi?.subtle) throw new Error('Web Crypto is unavailable.');
	return cryptoApi;
}

function bytes(value: Uint8Array): ArrayBuffer {
	return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

/** BIP85 core: derive the application entropy from a fully-hardened child key. */
export async function deriveBip85Entropy(master: HDKey, path: string): Promise<Uint8Array> {
	const child = master.derive(path);
	const childKey = child.privateKey;
	if (!childKey || childKey.length !== 32) throw new Error('BIP85 child key is unavailable.');
	const cryptoApi = webCrypto();
	const hmacKey = await cryptoApi.subtle.importKey(
		'raw', bytes(BIP85_ENTROPY_KEY), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
	);
	return new Uint8Array(await cryptoApi.subtle.sign('HMAC', hmacKey, bytes(childKey)));
}

export function bip85NostrPath(identity: number, accountIndex: number): string {
	assertBip85Index(identity, 'identity');
	assertBip85Index(accountIndex, 'accountIndex');
	return `m/${BIP85_PURPOSE}'/${NOSTR_APPLICATION}'/${identity}'/${accountIndex}'`;
}

export async function deriveBip85NostrEntropy(
	master: HDKey,
	identity: number,
	accountIndex: number
): Promise<Uint8Array> {
	return (await deriveBip85Entropy(master, bip85NostrPath(identity, accountIndex))).slice(0, 32);
}
