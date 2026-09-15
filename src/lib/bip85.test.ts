import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { nip19 } from 'nostr-tools';
import { assertBip85Index, bip85NostrPath, deriveBip85Entropy, deriveBip85NostrEntropy } from './bip85';

const genericMaster = HDKey.fromExtendedKey('xprv9s21ZrQH143K2LBWUUQRFXhucrQqBpKdRRxNVq2zBqsx8HVqFk2uYo8kmbaLLHRdqtQpUm98uKfu3vca1LqdGhUtyoFnCNkfmXRyPXLjbKb');

describe('Root derivation primitives', () => {
	it('matches the BIP39 and BIP32 standard vectors', () => {
		const entropy = new Uint8Array(16);
		const mnemonic = entropyToMnemonic(entropy, englishWordlist);
		expect(mnemonic).toBe('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
		expect(Buffer.from(mnemonicToEntropy(mnemonic, englishWordlist)).toString('hex')).toBe('00000000000000000000000000000000');
		expect(Buffer.from(mnemonicToSeedSync(mnemonic, '')).toString('hex')).toBe('5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4');
		expect(HDKey.fromMasterSeed(Uint8Array.from(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'))).privateExtendedKey)
			.toBe('xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi');
	});

	it('matches the official generic BIP85 vector', async () => {
		expect(Buffer.from(await deriveBip85Entropy(genericMaster, "m/83696968'/0'/0'")).toString('hex'))
			.toBe('efecfbccffea313214232d29e71563d941229afb4338c21f9517c41aaa0d16f00b83d2a09ef747e7a64e8e2bd5a14869e693da66ce94ac2da570ab7ee48618f7');
	});

	it('matches the official BIP85 Nostr vectors', async () => {
		const first = await deriveBip85NostrEntropy(genericMaster, 1, 1);
		const second = await deriveBip85NostrEntropy(genericMaster, 1, 2);
		expect(Buffer.from(first).toString('hex')).toBe('ff6eb0fcdf1ef87a2a06b0d7884d495b486d0faa210e9f80f23fd649d6e114d2');
		expect(Buffer.from(second).toString('hex')).toBe('917628689652288f6983c8a01db516d0697d5198dcf9de9010597f5e322fba6e');
		expect(nip19.nsecEncode(first)).toBe('nsec1lahtplxlrmu852sxkrtcsn2ftdyx6ra2yy8flq8j8ltyn4hpznfq23uvqz');
		expect(nip19.nsecEncode(second)).toBe('nsec1j9mzs6yk2g5g76vrezspmdgk6p5h65vcmnuaayqst9l4uv30hfhqje0jyh');
	});

	it('accepts only positive BIP85 base indices', () => {
		for (const value of [0, -1, 0.5, 0x80000000, Number.MAX_SAFE_INTEGER]) expect(() => assertBip85Index(value, 'index')).toThrow();
		expect(bip85NostrPath(1, 1)).toBe("m/83696968'/128002'/1'/1'");
	});
});
